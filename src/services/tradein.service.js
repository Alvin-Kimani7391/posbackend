/**
 * Trade-ins: a customer hands in a used device as part-payment on a purchase.
 *
 *   appraise -> (manager approves large / flagged offers) -> accept -> applied on a sale -> device is in stock as a used unit
 *
 * Safeguards a used-phone buyer needs: the seller's ID is recorded; the IMEI must be valid and not already in our stock;
 * iCloud/Google/account locks must be removed and the device checked as not stolen before an offer can be accepted; the
 * seller declares ownership; a frequent seller or a large offer needs a manager.
 *
 * Money: a trade-in is applied INSIDE the normal sale (see sale.service createSale) as a payment of method TRADE_IN. No cash
 * moves, so it never touches the cash drawer; the device value is the shop's cost of the used stock it receives.
 */
const TradeIn = require('../models/TradeIn');
const Product = require('../models/Product');
const SerialNumber = require('../models/SerialNumber');
const Customer = require('../models/Customer');
const Branch = require('../models/Branch');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { normalizePhone } = require('../utils/phone');
const { normalizeSerial, isValidImei } = require('../utils/imei');
const { hasPermission } = require('../utils/permissionCheck');
const { getCountry } = require('../constants/countries');
const { applyStockChange } = require('./inventory.service');
const { event } = require('./serial.service');

const DAY = 86400000;

const settingsOf = (b) => ({
  approvalAboveCents: b?.tradeInSettings?.approvalAboveCents ?? Math.round(3000000 * (getCountry(b?.countryCode).limitsScale || 1)), // KES 30,000 / TZS 600,000
  validDays: b?.tradeInSettings?.validDays ?? 7,
  warrantyMonths: b?.tradeInSettings?.warrantyMonths ?? 3,
});
const log = (t, event_, by, note) => t.history.push({ at: new Date(), event: event_, by, note });
const load = async (businessId, id) => {
  const t = await TradeIn.findOne({ _id: id, businessId });
  if (!t) throw ApiError.notFound('Trade-in not found');
  return t;
};
const slug = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Make an offer. Nothing is committed until the customer accepts and the device is applied on a sale. */
async function appraise(businessId, branchId, user, input) {
  const business = await Business.findById(businessId).select('tradeInSettings');
  const cfg = settingsOf(business);
  const branch = await Branch.findOne({ _id: branchId, businessId }).select('_id');
  if (!branch) throw ApiError.badRequest('Branch not found', 'BRANCH_NOT_FOUND');

  let { customerId, sellerName, sellerPhone } = input;
  if (customerId) {
    const c = await Customer.findOne({ _id: customerId, businessId }).select('name phone');
    if (!c) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
    sellerName = sellerName || c.name; sellerPhone = sellerPhone || c.phone;
  }
  if (!sellerName || !sellerPhone) throw ApiError.badRequest("The seller's name and phone are required", 'SELLER_REQUIRED');
  if (!normalizePhone(sellerPhone)) throw ApiError.badRequest("The seller's phone is not a valid Kenyan mobile number", 'BAD_PHONE');

  const d = { ...input.device };
  d.serialNumber = normalizeSerial(d.serialNumber);
  d.serialKind = d.serialKind || (d.category === 'PHONE' || !d.category ? 'imei' : 'serial');
  if (d.serialKind === 'imei' && !isValidImei(d.serialNumber)) throw ApiError.badRequest('Invalid IMEI: it must be 15 digits with a valid check digit. Dial *#06# on the device to read it.', 'INVALID_IMEI');
  if (d.serialKind === 'serial' && (d.serialNumber.length < 3 || d.serialNumber.length > 64)) throw ApiError.badRequest('Serial number must be 3-64 characters', 'INVALID_SERIAL');
  if (input.offer >= input.resalePrice) throw ApiError.badRequest('The offer must be lower than the resale price', 'OFFER_ABOVE_RESALE');

  const flags = [];
  const existing = await SerialNumber.findOne({ businessId, serialNumber: d.serialNumber }).select('status saleId');
  if (existing) {
    if (existing.status === 'sold') flags.push('RETURNED_TO_US'); // a unit this shop sold earlier: fine, noted
    else throw ApiError.conflict('This device is already in your stock records', 'DEVICE_ALREADY_IN_STOCK');
  }
  const open = await TradeIn.findOne({ businessId, 'device.serialNumber': d.serialNumber, status: { $in: ['APPRAISED', 'ACCEPTED'] } }).select('number');
  if (open) throw ApiError.conflict(`This device already has an open trade-in (${open.number})`, 'TRADE_IN_EXISTS');

  const idNumber = String(input.idNumber).trim().toUpperCase();
  const recent = await TradeIn.countDocuments({ businessId, idNumber, status: { $ne: 'CANCELLED' }, createdAt: { $gte: new Date(Date.now() - 30 * DAY) } });
  if (recent >= 3) flags.push('FREQUENT_SELLER');

  const needsApproval = input.offer > cfg.approvalAboveCents || flags.includes('FREQUENT_SELLER');
  const selfApprove = needsApproval && hasPermission(user, 'tradeins.approve');
  const seq = await nextSequence(businessId, 'tradein:business', undefined);
  const t = await TradeIn.create({
    businessId, branchId, number: `TI-${pad(seq)}`, customerId, sellerName, sellerPhone, idType: input.idType, idNumber,
    device: d, checklist: input.checklist || {}, offer: input.offer, resalePrice: input.resalePrice, flags, needsApproval,
    approvedBy: selfApprove ? user._id : undefined, approvedAt: selfApprove ? new Date() : undefined,
    expiresAt: new Date(Date.now() + cfg.validDays * DAY), appraisedBy: user._id,
    history: [{ at: new Date(), event: 'APPRAISED', by: user._id, note: `Offer ${input.offer} cents${flags.length ? ` (${flags.join(', ')})` : ''}` }],
  });
  await AuditLog.create({ businessId, branchId, userId: user._id, action: 'tradein.appraise', entityType: 'TradeIn', entityId: t._id, newValue: { number: t.number, offer: t.offer, flags } });
  return t;
}

async function approve(businessId, user, id) {
  const t = await load(businessId, id);
  if (t.status !== 'APPRAISED') throw ApiError.conflict(`Trade-in is ${t.status}`, 'INVALID_TRADEIN_STATE');
  if (!t.needsApproval) throw ApiError.badRequest('This offer does not need approval', 'NO_APPROVAL_NEEDED');
  t.approvedBy = user._id; t.approvedAt = new Date(); log(t, 'APPROVED', user._id);
  await t.save();
  await AuditLog.create({ businessId, branchId: t.branchId, userId: user._id, action: 'tradein.approve', entityType: 'TradeIn', entityId: t._id, newValue: { offer: t.offer } });
  return t;
}

/** Customer agrees. The checks must pass and the seller must declare they own the device. */
async function accept(businessId, user, id, { checklist, ownershipDeclared }) {
  const t = await load(businessId, id);
  if (t.status !== 'APPRAISED') throw ApiError.conflict(`Trade-in is ${t.status}`, 'INVALID_TRADEIN_STATE');
  if (t.expiresAt < new Date()) throw ApiError.conflict('This offer has expired. Appraise the device again.', 'OFFER_EXPIRED');
  if (checklist) t.checklist = { ...(t.checklist.toObject ? t.checklist.toObject() : t.checklist), ...checklist };
  const c = t.checklist;
  const missing = [['accountLocksRemoved', 'Account locks (iCloud / Google / Mi) must be removed'], ['notReportedStolen', 'The IMEI must be checked as not reported stolen'], ['imeiMatchesDevice', 'The IMEI must match the device']]
    .filter(([k]) => !c[k]).map(([, m]) => m);
  if (missing.length) throw ApiError.badRequest(missing.join('. ') + '.', 'CHECKS_INCOMPLETE');
  if (!ownershipDeclared) throw ApiError.badRequest('The seller must declare that they own the device', 'OWNERSHIP_REQUIRED');
  if (t.needsApproval && !t.approvedBy) throw ApiError.conflict('A manager must approve this offer first', 'TRADE_IN_NEEDS_APPROVAL');
  t.ownershipDeclared = true; t.status = 'ACCEPTED'; t.acceptedAt = new Date(); t.acceptedBy = user._id; log(t, 'ACCEPTED', user._id);
  await t.save();
  await AuditLog.create({ businessId, branchId: t.branchId, userId: user._id, action: 'tradein.accept', entityType: 'TradeIn', entityId: t._id, newValue: { offer: t.offer } });
  return t;
}

async function cancel(businessId, user, id, { reason }) {
  const t = await load(businessId, id);
  if (!['APPRAISED', 'ACCEPTED'].includes(t.status)) throw ApiError.conflict(`Trade-in is ${t.status} and can no longer be cancelled`, 'INVALID_TRADEIN_STATE');
  t.status = 'CANCELLED'; t.cancelReason = reason; log(t, 'CANCELLED', user._id, reason);
  await t.save();
  await AuditLog.create({ businessId, branchId: t.branchId, userId: user._id, action: 'tradein.cancel', entityType: 'TradeIn', entityId: t._id, newValue: { reason } });
  return t;
}

async function getTradeIn(businessId, id) { return load(businessId, id); }

async function list(businessId, { branchId, status, search, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  if (search) {
    const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: re }, { sellerName: re }, { sellerPhone: re }, { idNumber: re }, { 'device.serialNumber': re }, { 'device.model': re }];
  }
  const [items, total] = await Promise.all([
    TradeIn.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    TradeIn.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Called by createSale BEFORE its transaction: checks every trade-in is usable on this sale and returns them with their
 * total value. Must be ACCEPTED, unexpired, at the same branch (the device is physically there), and belong to the sale's
 * customer when both are known.
 */
async function prepareForSale(businessId, branchId, ids, customerId) {
  const unique = [...new Set(ids.map(String))];
  const list = await TradeIn.find({ _id: { $in: unique }, businessId });
  if (list.length !== unique.length) throw ApiError.badRequest('Trade-in not found', 'TRADE_IN_NOT_FOUND');
  const now = new Date();
  for (const t of list) {
    if (t.status !== 'ACCEPTED') throw ApiError.conflict(`Trade-in ${t.number} is ${t.status}, not ACCEPTED`, 'TRADE_IN_UNAVAILABLE');
    if (t.expiresAt < now) throw ApiError.conflict(`The offer for trade-in ${t.number} has expired`, 'OFFER_EXPIRED');
    if (String(t.branchId) !== String(branchId)) throw ApiError.badRequest(`Trade-in ${t.number} was taken at another branch`, 'TRADE_IN_OTHER_BRANCH');
    if (customerId && t.customerId && String(t.customerId) !== String(customerId)) throw ApiError.badRequest(`Trade-in ${t.number} belongs to a different customer`, 'TRADE_IN_CUSTOMER_MISMATCH');
  }
  return { list, total: list.reduce((s, t) => s + t.offer, 0) };
}

/** The "(Used)" product a traded-in model is received under (one per brand/model/storage). */
async function usedProductFor(business, t, session) {
  const cfg = settingsOf(business);
  const d = t.device;
  const sku = `USED-${slug([d.brand, d.model, d.storage].filter(Boolean).join('-'))}`.slice(0, 48);
  let product = await Product.findOne({ businessId: business._id, sku }).session(session);
  if (product) {
    if (!product.trackSerialNumber) throw ApiError.conflict(`A product with SKU ${sku} exists but is not serial-tracked`, 'USED_PRODUCT_CONFLICT');
    // the latest trade-in sets the cost and the asking price for this used model
    product.costPrice = t.offer; product.sellingPrice = t.resalePrice; product.status = 'active';
    await product.save({ session });
    return product;
  }
  [product] = await Product.create([{
    businessId: business._id, name: `${[d.brand, d.model, d.storage].filter(Boolean).join(' ')} (Used)`, sku, brand: d.brand, productType: 'physical', unit: 'piece',
    costPrice: t.offer, sellingPrice: t.resalePrice, taxRate: business.vatRegistered ? (business.taxSettings?.defaultTaxRate ?? 0) : 0,
    trackInventory: true, trackSerialNumber: true, serialKind: d.serialKind, warrantyMonths: cfg.warrantyMonths, status: 'active',
  }], { session });
  return product;
}

/**
 * Inside the sale's transaction: atomically claim each trade-in (ACCEPTED -> APPLIED, so it can only ever be used once),
 * receive the device into stock as a used unit and register its serial. Returns the TRADE_IN payment lines for the sale.
 */
async function applyToSale({ business, tradeIns, saleId, user, session }) {
  const payments = [];
  for (const prepared of tradeIns) {
    const t = await TradeIn.findOneAndUpdate(
      { _id: prepared._id, businessId: business._id, status: 'ACCEPTED', expiresAt: { $gte: new Date() } },
      { $set: { status: 'APPLIED', saleId }, $push: { history: { at: new Date(), event: 'APPLIED', by: user._id, note: 'Used as part-payment' } } },
      { session, new: true }
    );
    if (!t) throw ApiError.conflict(`Trade-in ${prepared.number} is no longer available`, 'TRADE_IN_UNAVAILABLE');

    const product = await usedProductFor(business, t, session);
    await applyStockChange({
      businessId: business._id, branchId: t.branchId, productId: product._id, variantId: null, quantityDelta: 1, type: 'ADJUSTMENT_IN',
      referenceType: 'TradeIn', referenceId: t._id, reason: `Trade-in ${t.number}`, performedBy: user._id, session,
    });

    const sn = t.device.serialNumber; const now = new Date();
    const existing = await SerialNumber.findOne({ businessId: business._id, serialNumber: sn }).session(session);
    let serial; let snapshot;
    if (existing) {
      if (existing.status !== 'sold') throw ApiError.conflict(`Device ${sn} is already in stock`, 'DEVICE_ALREADY_IN_STOCK');
      snapshot = {
        status: existing.status, productId: existing.productId, branchId: existing.branchId, saleId: existing.saleId, customerId: existing.customerId, soldAt: existing.soldAt,
        warrantyStart: existing.warrantyStart, warrantyEnd: existing.warrantyEnd, condition: existing.condition, costPrice: existing.costPrice,
      };
      serial = await SerialNumber.findOneAndUpdate({ _id: existing._id, status: 'sold' }, {
        $set: { status: 'in_stock', productId: product._id, branchId: t.branchId, condition: 'used', costPrice: t.offer, receivedAt: now, tradeInId: t._id },
        $unset: { saleId: 1, customerId: 1, soldAt: 1, warrantyStart: 1, warrantyEnd: 1 },
        $push: { history: event('TRADED_IN', { by: user._id, refType: 'TradeIn', refId: t._id, note: 'taken back from customer' }) },
      }, { session, new: true });
    } else {
      [serial] = await SerialNumber.create([{
        businessId: business._id, branchId: t.branchId, productId: product._id, variantId: null, serialNumber: sn, status: 'in_stock', condition: 'used',
        costPrice: t.offer, receivedAt: now, tradeInId: t._id, history: [event('RECEIVED', { by: user._id, refType: 'TradeIn', refId: t._id, note: `trade-in ${t.number}` })],
      }], { session });
    }
    t.productId = product._id; t.serialId = serial._id; t.serialSnapshot = snapshot;
    await TradeIn.updateOne({ _id: t._id }, { $set: { productId: product._id, serialId: serial._id, serialSnapshot: snapshot || null } }, { session });
    payments.push({ method: 'TRADE_IN', provider: 'tradein', amount: t.offer, reference: t.number, metadata: { tradeInId: t._id, serial: sn } });
  }
  return payments;
}

/**
 * The sale was cancelled: hand the device back. Only possible while the unit is still in stock (not resold, reserved or in
 * repair). A unit this shop sold earlier goes back to its previous owner record.
 */
async function reverseForSale({ businessId, saleId, user, session }) {
  const list = await TradeIn.find({ businessId, saleId, status: 'APPLIED' }).session(session);
  for (const t of list) {
    const serial = await SerialNumber.findOne({ _id: t.serialId, businessId }).session(session);
    if (!serial || serial.status !== 'in_stock') {
      throw ApiError.conflict(`The traded-in device ${t.device.serialNumber} has already been sold or moved, so this sale cannot be cancelled. Ask a manager to handle it.`, 'TRADE_IN_DEVICE_GONE');
    }
    await applyStockChange({
      businessId, branchId: serial.branchId, productId: serial.productId, variantId: null, quantityDelta: -1, type: 'ADJUSTMENT_OUT',
      referenceType: 'TradeIn', referenceId: t._id, reason: `Trade-in ${t.number} reversed: sale cancelled`, performedBy: user._id, session,
    });
    const prior = t.serialSnapshot;
    const set = prior ? { ...prior } : { status: 'withdrawn' };
    const unset = { tradeInId: 1 };
    if (!prior) Object.assign(unset, { saleId: 1 });
    await SerialNumber.updateOne({ _id: serial._id }, {
      $set: set, $unset: unset, $push: { history: event('TRADE_IN_REVERSED', { by: user._id, refType: 'TradeIn', refId: t._id, note: prior ? 'restored to previous owner' : 'handed back to the customer' }) },
    }, { session });
    await TradeIn.updateOne({ _id: t._id }, { $set: { status: 'REVERSED' }, $push: { history: { at: new Date(), event: 'REVERSED', by: user._id, note: 'Sale cancelled' } } }, { session });
  }
  return list.length;
}

module.exports = { appraise, approve, accept, cancel, getTradeIn, list, prepareForSale, applyToSale, reverseForSale, settingsOf };