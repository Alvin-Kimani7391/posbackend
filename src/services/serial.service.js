const mongoose = require('mongoose');
const SerialNumber = require('../models/SerialNumber');
const Product = require('../models/Product');
const Sale = require('../models/Sale');
const WarrantyClaim = require('../models/WarrantyClaim');
const RepairJob = require('../models/RepairJob');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { normalizeSerial, isValidImei } = require('../utils/imei');
const { applyStockChange } = require('./inventory.service');

const addMonths = (date, months) => {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // 31 Jan + 1 month -> 28/29 Feb, not March
  return d;
};

const event = (type, { by, refType, refId, note } = {}) => ({ at: new Date(), type, by, refType, refId, note });

/** Validate a list of serials for a product: format, IMEI check digit, duplicates within the list. */
function cleanSerials(product, serials) {
  const list = (serials || []).map(normalizeSerial);
  if (list.some((s) => s.length < 3 || s.length > 64)) throw ApiError.badRequest(`${product.name}: serial numbers must be 3-64 characters`, 'INVALID_SERIAL');
  const dup = list.filter((s, i) => list.indexOf(s) !== i);
  if (dup.length) throw ApiError.badRequest(`${product.name}: duplicate serial(s) in the list: ${[...new Set(dup)].join(', ')}`, 'DUPLICATE_SERIAL');
  if (product.serialKind === 'imei') {
    const bad = list.filter((s) => !isValidImei(s));
    if (bad.length) throw ApiError.badRequest(`${product.name}: invalid IMEI (must be 15 digits with a valid check digit): ${bad.join(', ')}`, 'INVALID_IMEI');
  }
  return list;
}

/**
 * Register received units. The count must equal the quantity received and no serial may already exist
 * anywhere in this business. Runs inside the caller's transaction.
 */
async function registerSerials({ businessId, branchId, userId, product, variantId = null, quantity, serials, purchaseId, supplierId, costPrice = 0, condition = 'new', session, location = 'RETAIL' }) {
  const list = cleanSerials(product, serials);
  if (list.length !== quantity) {
    throw ApiError.badRequest(`${product.name}: ${quantity} unit(s) received but ${list.length} serial number(s) given`, 'SERIAL_COUNT_MISMATCH');
  }
  const existing = await SerialNumber.find({ businessId, serialNumber: { $in: list } }).select('serialNumber status').session(session);
  if (existing.length) {
    throw ApiError.conflict(`Serial number(s) already registered: ${existing.map((e) => e.serialNumber).join(', ')}`, 'SERIAL_EXISTS');
  }
  const now = new Date();
  const docs = list.map((serialNumber) => ({
    businessId, branchId, location, productId: product._id, variantId: variantId || null, serialNumber, status: 'in_stock', condition,
    purchaseId, supplierId, costPrice, receivedAt: now,
    supplierWarrantyEnd: product.supplierWarrantyMonths ? addMonths(now, product.supplierWarrantyMonths) : undefined,
    history: [event('RECEIVED', { by: userId, refType: purchaseId ? 'Purchase' : 'ManualReceive', refId: purchaseId, note: location === 'WAREHOUSE' ? 'received into warehouse' : undefined })],
  }));
  try {
    await SerialNumber.insertMany(docs, { session });
  } catch (e) {
    if (e.code === 11000) throw ApiError.conflict('One of these serial numbers is already registered', 'SERIAL_EXISTS');
    throw e;
  }
  return list;
}

/**
 * Move specific units between the warehouse and the retail floor (inside the caller's transaction). Every unit must
 * be in stock, in this branch, of this product and currently in `from`; the move is appended to its own history.
 * Returns the normalised serial list.
 */
async function moveLocation({ businessId, branchId, product, variantId = null, serials, quantity, from, to, userId, refId, session }) {
  const list = cleanSerials(product, serials);
  if (list.length !== quantity) throw ApiError.badRequest(`${product.name}: ${quantity} unit(s) to move but ${list.length} serial number(s) given`, 'SERIAL_COUNT_MISMATCH');
  const fromQuery = from === 'WAREHOUSE' ? 'WAREHOUSE' : { $ne: 'WAREHOUSE' };
  for (const sn of list) {
    const unit = await SerialNumber.findOneAndUpdate(
      { businessId, branchId, serialNumber: sn, productId: product._id, variantId: variantId || null, status: 'in_stock', location: fromQuery },
      { $set: { location: to }, $push: { history: event('MOVED_LOCATION', { by: userId, refType: 'LocationTransfer', refId, note: `${from.toLowerCase()} -> ${to.toLowerCase()}` }) } },
      { new: true, session }
    );
    if (!unit) throw ApiError.badRequest(`${product.name}: unit ${sn} is not in stock in the ${from.toLowerCase()} of this branch`, 'SERIAL_NOT_IN_LOCATION');
  }
  return list;
}

/**
 * Mark units sold: must be in stock, in THIS branch and for THIS product (a serial of another product or branch
 * can never be sold by mistake). Starts the shop warranty. Returns the updated docs, or throws.
 * `lenient` (offline sync) returns the list of serials that could not be sold instead of throwing.
 */
async function markSold({ businessId, branchId, product, serials, saleId, customerId, soldAt = new Date(), userId, session, lenient = false }) {
  const missing = [];
  for (const sn of serials) {
    const set = { status: 'sold', saleId, soldAt };
    if (customerId) set.customerId = customerId;
    if (product.warrantyMonths) { set.warrantyStart = soldAt; set.warrantyEnd = addMonths(soldAt, product.warrantyMonths); }
    const updated = await SerialNumber.findOneAndUpdate(
      { businessId, serialNumber: sn, productId: product._id, ...(lenient ? {} : { branchId }), status: 'in_stock', location: { $ne: 'WAREHOUSE' } }, // warehouse units must be moved to retail first
      { $set: set, $push: { history: event('SOLD', { by: userId, refType: 'Sale', refId: saleId }) } },
      { session, new: true }
    );
    if (!updated) missing.push(sn);
  }
  if (missing.length && !lenient) throw ApiError.badRequest(`Serial number(s) not available for ${product.name} at this branch: ${missing.join(', ')}`, 'SERIAL_NOT_AVAILABLE');
  return missing;
}

/** Sale cancelled: the units go straight back on the shelf (they never left the shop). */
async function releaseFromSale({ businessId, saleId, serials, userId, session }) {
  await SerialNumber.updateMany(
    { businessId, serialNumber: { $in: serials }, saleId },
    { $set: { status: 'in_stock' }, $unset: { saleId: 1, customerId: 1, soldAt: 1, warrantyStart: 1, warrantyEnd: 1 },
      $push: { history: event('SALE_CANCELLED', { by: userId, refType: 'Sale', refId: saleId }) } },
    { session }
  );
}

/** Customer return of specific units. They are held as `returned` until inspected (or damaged straight away). */
async function markReturned({ businessId, saleId, serials, userId, refundId, damaged = false, session }) {
  for (const sn of serials) {
    const updated = await SerialNumber.findOneAndUpdate(
      { businessId, serialNumber: sn, saleId, status: 'sold' },
      { $set: { status: damaged ? 'damaged' : 'returned' },
        $push: { history: event('RETURNED', { by: userId, refType: 'Refund', refId: refundId, note: damaged ? 'disposed' : 'awaiting inspection' }) } },
      { session, new: true }
    );
    if (!updated) throw ApiError.conflict(`Serial ${sn} is not currently sold on this sale (already returned?)`, 'SERIAL_NOT_RETURNABLE');
  }
}

/** Inspect a returned unit: back into sellable stock (with stock +1) or written off as damaged. */
async function inspectReturned(businessId, userId, id, { outcome, note }) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const unit = await SerialNumber.findOne({ _id: id, businessId }).session(session);
      if (!unit) throw ApiError.notFound('Serial number not found');
      if (unit.status !== 'returned') throw ApiError.conflict(`Unit is ${unit.status}, only returned units can be inspected`, 'INVALID_SERIAL_STATE');
      if (outcome === 'RESTOCK') {
        await applyStockChange({
          businessId, branchId: unit.branchId, productId: unit.productId, variantId: unit.variantId || null,
          quantityDelta: 1, type: 'RETURN', referenceType: 'SerialNumber', referenceId: unit._id,
          reason: `Returned unit ${unit.serialNumber} passed inspection`, performedBy: userId, session, allowNegative: true,
        });
        unit.status = 'in_stock';
        unit.saleId = undefined; unit.customerId = undefined; unit.soldAt = undefined; unit.warrantyStart = undefined; unit.warrantyEnd = undefined;
        unit.condition = unit.condition === 'new' ? 'refurbished' : unit.condition; // a returned unit is no longer factory-new
      } else {
        unit.status = 'damaged';
      }
      unit.history.push(event(outcome === 'RESTOCK' ? 'INSPECTED_RESTOCK' : 'INSPECTED_DAMAGED', { by: userId, note }));
      await unit.save({ session });
      await AuditLog.create([{ businessId, branchId: unit.branchId, userId, action: 'serial.inspect', entityType: 'SerialNumber', entityId: unit._id, newValue: { outcome, note } }], { session });
      result = unit;
    });
    return result;
  } finally { session.endSession(); }
}

const warrantyState = (end, now = new Date()) => (!end ? 'NONE' : new Date(end) >= now ? 'ACTIVE' : 'EXPIRED');

/** Everything about one unit, found by its serial/IMEI: owner, sale, warranty status, claims and repairs. */
async function lookup(businessId, serial) {
  const unit = await SerialNumber.findOne({ businessId, serialNumber: normalizeSerial(serial) })
    .populate('productId', 'name sku brand warrantyMonths supplierWarrantyMonths')
    .populate('customerId', 'name phone')
    .populate('supplierId', 'name');
  if (!unit) throw ApiError.notFound('No unit with that serial number / IMEI');
  const [sale, claims, repairs] = await Promise.all([
    unit.saleId ? Sale.findOne({ _id: unit.saleId, businessId }).select('receiptNumber createdAt total').lean() : null,
    WarrantyClaim.find({ businessId, serialId: unit._id }).select('claimNumber status decision createdAt').sort({ createdAt: -1 }).lean(),
    RepairJob.find({ businessId, serialId: unit._id }).select('jobNumber status createdAt').sort({ createdAt: -1 }).lean(),
  ]);
  return {
    unit,
    sale,
    warranty: { shop: warrantyState(unit.warrantyEnd), shopEnds: unit.warrantyEnd, supplier: warrantyState(unit.supplierWarrantyEnd), supplierEnds: unit.supplierWarrantyEnd },
    claims, repairs,
  };
}

async function listSerials(businessId, { branchId, productId, status, search, location, page = 1, limit = 50 }) {
  const filter = { businessId };
  if (location) filter.location = location === 'WAREHOUSE' ? 'WAREHOUSE' : { $ne: 'WAREHOUSE' };
  if (branchId) filter.branchId = branchId;
  if (productId) filter.productId = productId;
  if (status) filter.status = status;
  if (search) filter.serialNumber = new RegExp(normalizeSerial(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const [items, total] = await Promise.all([
    SerialNumber.find(filter).select('-history').populate('productId', 'name sku').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    SerialNumber.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Units whose shop warranty ends within `days` (reminder list for the customer). */
async function warrantiesExpiring(businessId, { days = 30, branchId }) {
  const now = new Date();
  const filter = { businessId, status: 'sold', warrantyEnd: { $gte: now, $lte: new Date(now.getTime() + days * 86400000) } };
  if (branchId) filter.branchId = branchId;
  return SerialNumber.find(filter).select('serialNumber warrantyEnd customerId productId').populate('productId', 'name').populate('customerId', 'name phone').sort({ warrantyEnd: 1 }).limit(500);
}

module.exports = { addMonths, event, cleanSerials, registerSerials, moveLocation, markSold, releaseFromSale, markReturned, inspectReturned, lookup, listSerials, warrantiesExpiring, warrantyState };