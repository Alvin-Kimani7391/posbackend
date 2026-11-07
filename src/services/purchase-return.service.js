const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const PurchaseReturn = require('../models/PurchaseReturn');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Batch = require('../models/Batch');
const SerialNumber = require('../models/SerialNumber');
const BranchInventory = require('../models/BranchInventory');
const WarehouseInventory = require('../models/WarehouseInventory');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { nextSequence, pad } = require('../models/Counter');
const { fromCents } = require('../utils/money');
const { applyStockChange } = require('./inventory.service');

const round3 = (n) => Math.round(n * 1000) / 1000;
const oid = (v) => new mongoose.Types.ObjectId(String(v));

async function inTx(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally { session.endSession(); }
}

/** Value (cents) credited for returning `qty` of a purchase line. The last unit takes the remainder, so no cent is lost to rounding. */
function creditFor(item, qty) {
  const left = round3(item.quantity - (item.returnedQuantity || 0));
  const remainingValue = (item.total || 0) - (item.returnedValue || 0);
  if (qty >= left) return remainingValue;
  return Math.min(remainingValue, Math.round((item.total * qty) / item.quantity));
}

/** The stock row this purchase line was received into. */
function inventoryRow(purchase, item) {
  const loc = item.receivedLocation || 'RETAIL';
  if (loc === 'WAREHOUSE') {
    return WarehouseInventory.findOne({ businessId: purchase.businessId, warehouseId: item.receivedWarehouseId, productId: item.productId, variantId: item.variantId || null }).lean();
  }
  return BranchInventory.findOne({ businessId: purchase.businessId, branchId: purchase.branchId, productId: item.productId, variantId: item.variantId || null }).lean();
}

// ---------------------------------------------------------------- what can be returned
/**
 * Everything the "Return purchase" screen needs for one purchase: per line how much was bought, already returned, how much is
 * STILL on the shelf (goods that were sold cannot go back to the supplier), batches and serial numbers that can go back,
 * plus the money position (what is still owed, what was paid, the supplier's running balance). Money fields end in "Cents".
 */
async function eligibility(businessId, purchaseId) {
  const purchase = await Purchase.findOne({ _id: purchaseId, businessId }).populate('supplierId', 'name phone currentBalance');
  if (!purchase) throw ApiError.notFound('Purchase not found');
  const received = purchase.receivedStatus === 'RECEIVED';
  const lines = [];
  for (let i = 0; i < purchase.items.length; i += 1) {
    const item = purchase.items[i];
    const product = await Product.findOne({ _id: item.productId, businessId }).select('name sku trackInventory trackBatch trackSerialNumber').lean();
    const factor = item.unitFactor || 1;
    const returned = item.returnedQuantity || 0;
    const left = round3(item.quantity - returned);
    const loc = item.receivedLocation || 'RETAIL';
    const row = product?.trackInventory ? await inventoryRow(purchase, item) : null;
    const onHandBase = product?.trackInventory ? Math.max(0, (row?.quantity || 0) - (row?.reservedQuantity || 0)) : null;
    // Most that can go back = what is left on the invoice AND what is still physically in stock.
    let maxQty = left;
    if (onHandBase != null) maxQty = Math.min(maxQty, Math.floor((onHandBase / factor) * 1000) / 1000);
    let serials = [];
    if (product?.trackSerialNumber) {
      serials = (await SerialNumber.find({ businessId, purchaseId: purchase._id, productId: item.productId, variantId: item.variantId || null, status: 'in_stock', location: loc })
        .select('serialNumber').sort({ serialNumber: 1 }).lean()).map((s) => s.serialNumber);
      maxQty = Math.min(maxQty, Math.floor(serials.length / factor));
    }
    let batches = [];
    if (product?.trackBatch) {
      batches = await Batch.find({ businessId, purchaseId: purchase._id, productId: item.productId, variantId: item.variantId || null, location: loc, status: 'active', quantity: { $gt: 0 } })
        .select('batchNumber quantity expiryDate').sort({ expiryDate: 1 }).lean();
      const inBatches = batches.reduce((s, b) => s + b.quantity, 0);
      maxQty = Math.min(maxQty, Math.floor((inBatches / factor) * 1000) / 1000);
    }
    lines.push({
      itemIndex: i, productId: item.productId, variantId: item.variantId || null, name: item.nameSnapshot || product?.name, sku: product?.sku,
      unitName: item.unitName || 'unit', unitFactor: factor, location: loc,
      quantity: item.quantity, returnedQuantity: returned, returnableQuantity: left, onHandBase, maxQuantity: Math.max(0, maxQty),
      unitCostCents: item.unitCost, lineTotalCents: item.total, returnedValueCents: item.returnedValue || 0,
      trackBatch: !!product?.trackBatch, trackSerial: !!product?.trackSerialNumber,
      serials, batches: batches.map((b) => ({ batchNumber: b.batchNumber, quantity: b.quantity, expiryDate: b.expiryDate })),
    });
  }
  const sup = purchase.supplierId || {};
  return {
    purchase: {
      _id: purchase._id, purchaseNumber: purchase.purchaseNumber, invoiceNumber: purchase.invoiceNumber, purchaseDate: purchase.purchaseDate,
      receivedStatus: purchase.receivedStatus, returnStatus: purchase.returnStatus || 'NONE', paymentStatus: purchase.paymentStatus, branchId: purchase.branchId,
      totalCents: purchase.total, amountPaidCents: purchase.amountPaid, balanceCents: purchase.balance, returnedAmountCents: purchase.returnedAmount || 0,
    },
    supplier: { _id: sup._id, name: sup.name, phone: sup.phone, balanceCents: sup.currentBalance || 0 },
    canReturn: received && lines.some((l) => l.maxQuantity > 0),
    blockedReason: !received ? 'Only purchases that have been received can be returned. A purchase that has not arrived yet can simply be left unreceived.'
      : (lines.every((l) => l.returnableQuantity <= 0) ? 'Everything on this purchase has already been returned.'
        : (lines.every((l) => l.maxQuantity <= 0) ? 'None of the goods from this purchase are left in stock to send back.' : null)),
    lines,
  };
}

// ---------------------------------------------------------------- make a return
async function createReturn(businessId, userId, purchaseId, { reason, reasonNote, returnDate, creditNoteNumber, notes, lines }) {
  const dup = new Set();
  lines.forEach((l) => { if (dup.has(l.itemIndex)) throw ApiError.badRequest('A product is listed twice. Combine the quantities on one line.', 'DUPLICATE_LINE'); dup.add(l.itemIndex); });

  return inTx(async (session) => {
    const purchase = await Purchase.findOne({ _id: purchaseId, businessId }).session(session);
    if (!purchase) throw ApiError.notFound('Purchase not found');
    if (purchase.receivedStatus !== 'RECEIVED') throw ApiError.conflict('Only received purchases can be returned', 'NOT_RECEIVED');
    const supplier = await Supplier.findOne({ _id: purchase.supplierId, businessId }).session(session);
    if (!supplier) throw ApiError.badRequest('Supplier not found', 'INVALID_SUPPLIER');

    const built = [];
    let totalCredit = 0;

    for (const l of lines) {
      const item = purchase.items[l.itemIndex];
      if (!item) throw ApiError.badRequest('That product is not on this purchase', 'LINE_NOT_FOUND');
      const left = round3(item.quantity - (item.returnedQuantity || 0));
      if (l.quantity > left) throw ApiError.badRequest(`${item.nameSnapshot}: only ${left} ${item.unitName || 'unit'}(s) can still be returned`, 'EXCEEDS_PURCHASED');

      const product = await Product.findOne({ _id: item.productId, businessId }).session(session);
      const factor = item.unitFactor || 1;
      const baseQty = round3(l.quantity * factor);
      const loc = item.receivedLocation || 'RETAIL';
      const whId = loc === 'WAREHOUSE' ? item.receivedWarehouseId : null;
      const entry = { itemIndex: l.itemIndex, productId: item.productId, variantId: item.variantId, nameSnapshot: item.nameSnapshot, quantity: l.quantity, unitName: item.unitName, unitFactor: factor, baseQuantity: baseQty, unitCost: item.unitCost, location: loc, warehouseId: whId, serialNumbers: [], batches: [] };

      // 1) stock leaves the pool it came into (retail / warehouse). Refuses when the goods have since been sold.
      if (product?.trackInventory) {
        try {
          await applyStockChange({
            businessId, branchId: purchase.branchId, productId: item.productId, variantId: item.variantId || null, quantityDelta: -baseQty, warehouseId: whId,
            type: 'PURCHASE_RETURN', referenceType: 'PurchaseReturn', referenceId: purchase._id,
            reason: `Returned to ${supplier.name}: ${purchase.purchaseNumber} (${reason})`, performedBy: userId, session, location: loc,
          });
        } catch (err) {
          if (err.code === 'INSUFFICIENT_STOCK') throw ApiError.badRequest(`${item.nameSnapshot}: not enough in stock to return ${l.quantity} ${item.unitName || 'unit'}(s). ${err.message.replace(/^Insufficient [a-z]+ stock /, 'Stock now ')}. Goods already sold cannot go back to the supplier.`, 'INSUFFICIENT_STOCK');
          throw err;
        }
      }

      // 2) serial numbers / IMEIs: the exact units must be named, and must still be in stock from THIS purchase
      if (product?.trackSerialNumber) {
        const wanted = [...new Set((l.serialNumbers || []).map((s) => s.trim().toUpperCase()).filter(Boolean))];
        if (wanted.length !== baseQty) throw ApiError.badRequest(`${item.nameSnapshot}: select exactly ${baseQty} serial number(s) / IMEI(s) to return`, 'SERIAL_COUNT_MISMATCH');
        const docs = await SerialNumber.find({ businessId, serialNumber: { $in: wanted }, purchaseId: purchase._id, productId: item.productId, variantId: item.variantId || null, status: 'in_stock', location: loc }).session(session);
        if (docs.length !== wanted.length) {
          const found = new Set(docs.map((d) => d.serialNumber));
          throw ApiError.badRequest(`${item.nameSnapshot}: ${wanted.filter((s) => !found.has(s)).join(', ')} cannot be returned (sold, already returned, or not from this purchase)`, 'SERIAL_NOT_RETURNABLE');
        }
        for (const d of docs) {
          d.status = 'returned_to_supplier';
          d.history.push({ type: 'RETURNED_TO_SUPPLIER', by: userId, refType: 'Purchase', refId: purchase._id, note: `Returned to ${supplier.name} (${reason})` });
          await d.save({ session });
        }
        entry.serialNumbers = wanted;
      }

      // 3) batches: take the quantity out of this purchase's own batches, earliest expiry first
      if (product?.trackBatch) {
        const pool = await Batch.find({ businessId, purchaseId: purchase._id, productId: item.productId, variantId: item.variantId || null, location: loc, status: 'active', quantity: { $gt: 0 } }).sort({ expiryDate: 1, createdAt: 1 }).session(session);
        let need = baseQty;
        for (const b of pool) {
          if (need <= 0) break;
          const take = Math.min(b.quantity, need);
          b.quantity = round3(b.quantity - take);
          if (b.quantity === 0) { b.status = 'depleted'; b.statusReason = 'Returned to supplier'; b.statusChangedAt = new Date(); b.statusChangedBy = userId; }
          await b.save({ session });
          entry.batches.push({ batchId: b._id, batchNumber: b.batchNumber, quantity: take });
          need = round3(need - take);
        }
        if (need > 0) throw ApiError.badRequest(`${item.nameSnapshot}: the batches from this purchase no longer hold ${baseQty} unit(s) (${need} already sold)`, 'BATCH_STOCK_SHORT');
      }

      // 4) money for this line
      const credit = creditFor(item, l.quantity);
      entry.total = credit;
      totalCredit += credit;
      item.returnedQuantity = round3((item.returnedQuantity || 0) + l.quantity);
      item.returnedValue = (item.returnedValue || 0) + credit;
      built.push(entry);
    }

    // purchase + supplier money
    const balanceBefore = purchase.balance;
    const supplierBefore = supplier.currentBalance || 0;
    purchase.returnedAmount = (purchase.returnedAmount || 0) + totalCredit;
    purchase.returnStatus = purchase.items.every((it) => round3(it.quantity - (it.returnedQuantity || 0)) <= 0) ? 'FULL' : 'PARTIAL';
    purchase.markModified('items');
    purchase.balance = Math.max(0, purchase.total - purchase.returnedAmount - purchase.amountPaid); // also kept by the model hook
    purchase.paymentStatus = purchase.balance === 0 ? 'PAID' : purchase.amountPaid > 0 ? 'PARTIAL' : 'UNPAID';
    await purchase.save({ session });

    const appliedToBalance = Math.min(totalCredit, balanceBefore);
    const refundDue = totalCredit - appliedToBalance; // already paid to the supplier: they owe it back
    await Supplier.updateOne({ _id: supplier._id }, { $inc: { currentBalance: -totalCredit } }, { session });

    const seq = await nextSequence(businessId, 'purchasereturn:business', session);
    const [ret] = await PurchaseReturn.create([{
      businessId, branchId: purchase.branchId, number: `PR-${pad(seq)}`, purchaseId: purchase._id, purchaseNumber: purchase.purchaseNumber, supplierId: supplier._id,
      returnDate: returnDate || new Date(), reason, reasonNote, creditNoteNumber, lines: built, notes,
      totalCredit, appliedToBalance, refundDue, refundReceived: 0, refundStatus: refundDue > 0 ? 'PENDING' : 'NONE',
      balanceBefore, balanceAfter: purchase.balance, supplierBalanceBefore: supplierBefore, supplierBalanceAfter: supplierBefore - totalCredit,
      createdBy: userId,
    }], { session });

    await AuditLog.create([{
      businessId, branchId: purchase.branchId, userId, action: 'purchase.return', entityType: 'PurchaseReturn', entityId: ret._id,
      newValue: { number: ret.number, purchaseNumber: purchase.purchaseNumber, supplier: supplier.name, reason, lines: built.length, totalCredit, appliedToBalance, refundDue },
    }], { session });

    return ret;
  });
}

// ---------------------------------------------------------------- refunds from the supplier
/** The supplier paid back (part of) the money they owe for returned goods that had already been paid for. */
async function recordRefund(businessId, userId, id, { amount, method, reference, note }) {
  return inTx(async (session) => {
    const ret = await PurchaseReturn.findOne({ _id: id, businessId }).session(session);
    if (!ret) throw ApiError.notFound('Purchase return not found');
    const open = ret.refundDue - ret.refundReceived;
    if (open <= 0) throw ApiError.conflict('Nothing is waiting to be refunded on this return', 'NO_REFUND_DUE');
    if (amount > open) throw ApiError.badRequest(`The supplier only owes ${fromCents(open).toLocaleString()} on this return`, 'REFUND_EXCEEDS_DUE');
    ret.refunds.push({ amount, method, reference, note, at: new Date(), by: userId });
    ret.refundReceived += amount;
    ret.refundStatus = ret.refundReceived >= ret.refundDue ? 'SETTLED' : 'PARTIAL';
    await ret.save({ session });
    // the supplier's balance had gone negative (they owed us); cash received brings it back up
    await Supplier.updateOne({ _id: ret.supplierId }, { $inc: { currentBalance: amount } }, { session });
    await AuditLog.create([{ businessId, branchId: ret.branchId, userId, action: 'purchase.return.refund', entityType: 'PurchaseReturn', entityId: ret._id, newValue: { number: ret.number, amount, method, reference } }], { session });
    return ret;
  });
}

/** Owner decides not to take cash: the supplier keeps the money as a credit against the next invoice (supplier balance stays negative). */
async function holdAsCredit(businessId, userId, id, { note } = {}) {
  const ret = await PurchaseReturn.findOne({ _id: id, businessId });
  if (!ret) throw ApiError.notFound('Purchase return not found');
  if (ret.refundDue - ret.refundReceived <= 0 || !['PENDING', 'PARTIAL'].includes(ret.refundStatus)) throw ApiError.conflict('There is no open refund to keep as credit', 'NO_REFUND_DUE');
  ret.refundStatus = 'CREDIT_HELD';
  if (note) ret.notes = [ret.notes, note].filter(Boolean).join(' | ');
  await ret.save();
  await AuditLog.create({ businessId, branchId: ret.branchId, userId, action: 'purchase.return.credit_held', entityType: 'PurchaseReturn', entityId: ret._id, newValue: { number: ret.number, held: ret.refundDue - ret.refundReceived } });
  return ret;
}

// ---------------------------------------------------------------- reading
function buildFilter(businessId, q = {}) {
  const f = { businessId: oid(businessId) };
  if (q.branchId) f.branchId = oid(q.branchId);
  if (q.supplierId) f.supplierId = oid(q.supplierId);
  if (q.purchaseId) f.purchaseId = oid(q.purchaseId);
  if (q.reason) f.reason = q.reason;
  if (q.refundStatus) f.refundStatus = q.refundStatus;
  if (q.from || q.to) { f.returnDate = {}; if (q.from) f.returnDate.$gte = new Date(q.from); if (q.to) { const t = new Date(q.to); t.setHours(23, 59, 59, 999); f.returnDate.$lte = t; } }
  if (q.search) { const re = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); f.$or = [{ number: re }, { purchaseNumber: re }, { creditNoteNumber: re }]; }
  return f;
}

async function listReturns(businessId, q = {}) {
  const page = Number(q.page) || 1; const limit = Number(q.limit) || 20;
  const filter = buildFilter(businessId, q);
  const [items, total] = await Promise.all([
    PurchaseReturn.find(filter).populate('supplierId', 'name').sort({ returnDate: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    PurchaseReturn.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getReturn(businessId, id) {
  const ret = await PurchaseReturn.findOne({ _id: id, businessId }).populate('supplierId', 'name phone').populate('createdBy', 'name');
  if (!ret) throw ApiError.notFound('Purchase return not found');
  return ret;
}

/** Headline numbers for the Purchase returns screen (KES). Respects the same filters as the list. */
async function summary(businessId, q = {}) {
  const filter = buildFilter(businessId, { ...q, refundStatus: undefined });
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const [agg] = await PurchaseReturn.aggregate([
    { $match: filter },
    { $group: {
      _id: null, count: { $sum: 1 }, totalCredit: { $sum: '$totalCredit' }, appliedToBalance: { $sum: '$appliedToBalance' },
      refundDue: { $sum: '$refundDue' }, refundReceived: { $sum: '$refundReceived' },
      pendingRefund: { $sum: { $cond: [{ $in: ['$refundStatus', ['PENDING', 'PARTIAL']] }, { $subtract: ['$refundDue', '$refundReceived'] }, 0] } },
      heldCredit: { $sum: { $cond: [{ $eq: ['$refundStatus', 'CREDIT_HELD'] }, { $subtract: ['$refundDue', '$refundReceived'] }, 0] } },
      thisMonthCount: { $sum: { $cond: [{ $gte: ['$returnDate', startOfMonth] }, 1, 0] } },
      thisMonthCredit: { $sum: { $cond: [{ $gte: ['$returnDate', startOfMonth] }, '$totalCredit', 0] } },
    } },
  ]);
  const a = agg || {};
  return {
    count: a.count || 0, totalCredit: fromCents(a.totalCredit), reducedWhatYouOwe: fromCents(a.appliedToBalance),
    refundDue: fromCents(a.refundDue), refundReceived: fromCents(a.refundReceived), pendingRefund: fromCents(a.pendingRefund), heldCredit: fromCents(a.heldCredit),
    thisMonthCount: a.thisMonthCount || 0, thisMonthCredit: fromCents(a.thisMonthCredit),
  };
}

module.exports = { eligibility, createReturn, recordRefund, holdAsCredit, listReturns, getReturn, summary };