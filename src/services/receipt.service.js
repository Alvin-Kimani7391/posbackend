const Receipt = require('../models/Receipt');
const Sale = require('../models/Sale');
const CashShift = require('../models/CashShift');
const CashRegister = require('../models/CashRegister');
const Device = require('../models/Device');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { fromCents } = require('../utils/money');
const { newVerifyToken, isValidToken } = require('../utils/receiptToken');

/**
 * Makes sure a receipt has its QR verification token. New receipts get one when created (Receipt model); this covers
 * receipts issued before the feature, so reprinting an old receipt also gives a QR that really verifies.
 * Concurrency-safe: only a receipt that still has NO token is updated.
 */
async function ensureVerifyToken(receipt) {
  if (receipt.verifyToken) return receipt;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const updated = await Receipt.findOneAndUpdate(
        { _id: receipt._id, $or: [{ verifyToken: { $exists: false } }, { verifyToken: null }] },
        { $set: { verifyToken: newVerifyToken() } },
        { new: true }
      );
      if (updated) { receipt.verifyToken = updated.verifyToken; return receipt; }
      const fresh = await Receipt.findById(receipt._id); // someone else just set it
      if (fresh && fresh.verifyToken) { receipt.verifyToken = fresh.verifyToken; return receipt; }
    } catch (err) {
      if (!(err && err.code === 11000)) throw err; // token collision: try another
    }
  }
  return receipt;
}

async function getReceiptBySale(businessId, saleId) {
  const receipt = await Receipt.findOne({ businessId, saleId });
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return ensureVerifyToken(receipt);
}

/** Called when the POS actually sends the receipt to a printer - increments the historical print count. */
async function recordPrint(businessId, saleId) {
  const receipt = await Receipt.findOneAndUpdate(
    { businessId, saleId },
    { $inc: { printCount: 1 }, $set: { printedAt: new Date() } },
    { new: true }
  );
  if (!receipt) throw ApiError.notFound('Receipt not found');
  return receipt;
}

const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

async function audit(user, receipt, action, extra, meta) {
  try {
    await AuditLog.create({
      businessId: user.businessId, branchId: receipt ? receipt.branchId : undefined, userId: user._id, action,
      entityType: 'Receipt', entityId: receipt ? receipt._id : undefined, newValue: extra,
      ipAddress: meta && meta.ip, userAgent: meta && meta.userAgent,
    });
  } catch (err) { console.error('receipt verify audit failed', err.message); }
}

/**
 * Verify a receipt for the signed-in staff member.
 *   { token }          - the secret read from the QR code            -> a miss is a FAKE receipt (audited + owner alerted)
 *   { receiptNumber }  - typed by hand (QR damaged / not readable)   -> a miss is only "not found" (typos happen, no alarm)
 * Everything is scoped to the caller's OWN business: another shop's receipt is simply "not found", never leaked.
 */
async function verify(user, { token, receiptNumber }, meta = {}) {
  if (!user || !user.businessId) throw ApiError.forbidden('Receipt verification is for business staff accounts', 'FORBIDDEN');
  const businessId = user.businessId;
  const bySecret = !!token;
  let receipt = null;

  if (bySecret) {
    if (isValidToken(token)) receipt = await Receipt.findOne({ businessId, verifyToken: token });
  } else if (receiptNumber) {
    const n = String(receiptNumber).trim();
    receipt = await Receipt.findOne({ businessId, $or: [{ receiptNumber: n }, { invoiceNumber: n }] });
    if (receipt) receipt = await ensureVerifyToken(receipt);
  }

  const sale = receipt ? await Sale.findOne({ _id: receipt.saleId, businessId }).lean() : null;

  if (!receipt || !sale) {
    if (bySecret) {
      await audit(user, null, 'receipt.verify_fake', { inputHint: String(token || '').slice(0, 6) }, meta);
      try { await require('./notification.service').notifyFakeReceipt(businessId, user, { inputHint: String(token || '').slice(0, 6) }); } catch (e) { console.error('fake receipt alert failed', e.message); }
    }
    return { verdict: 'FAKE', status: 'NOT_FOUND', typed: !bySecret, message: bySecret ? 'No sale in this business matches this receipt QR code.' : 'No sale matches that receipt number.' };
  }

  // ---- sale state ----
  const items = sale.items || [];
  const soldQty = sum(items, (i) => i.quantity);
  const refundedQty = sum(items, (i) => i.refundedQuantity);
  let status = 'VALID';
  const warnings = [];
  if (sale.saleStatus === 'CANCELLED') status = 'CANCELLED';
  else if (soldQty > 0 && refundedQty >= soldQty) status = 'REFUNDED';
  else if (refundedQty > 0) { status = 'PARTLY_REFUNDED'; warnings.push('PARTLY_REFUNDED'); }
  if (status === 'VALID' && sale.balance > 0) { status = 'UNPAID_BALANCE'; warnings.push('UNPAID_BALANCE'); }
  if (sale.reviewStatus === 'PENDING') warnings.push('PENDING_REVIEW');

  // ---- who served / which till ----
  const [cashier, shift, device] = await Promise.all([
    User.findById(sale.cashierId).select('name').lean(),
    sale.shiftId ? CashShift.findById(sale.shiftId).select('registerId').lean() : null,
    sale.deviceId ? Device.findOne({ businessId, deviceId: sale.deviceId }).select('deviceCode name').lean() : null,
  ]);
  const register = shift && shift.registerId ? await CashRegister.findById(shift.registerId).select('name code').lean() : null;
  const till = register ? `${register.name} (${register.code})` : (device && (device.deviceCode || device.name)) || null;

  // ---- count this scan (previous values are read BEFORE it is counted) ----
  const previous = { count: receipt.verifyCount || 0, at: receipt.lastVerifiedAt || null };
  const now = new Date();
  await Receipt.updateOne({ _id: receipt._id }, { $inc: { verifyCount: 1 }, $set: { lastVerifiedAt: now, lastVerifiedBy: user._id } });
  await Receipt.updateOne({ _id: receipt._id, firstVerifiedAt: null }, { $set: { firstVerifiedAt: now } });
  await audit(user, receipt, 'receipt.verify', { status, receiptNumber: receipt.receiptNumber }, meta);

  const d = receipt.toJSON().receiptData || {};
  const cur = (d.locale && d.locale.currency) || 'KES';
  return {
    verdict: status === 'CANCELLED' ? 'INVALID' : 'GENUINE',
    status,
    warnings,
    receipt: {
      receiptNumber: receipt.receiptNumber,
      invoiceNumber: receipt.invoiceNumber || null,
      soldAt: receipt.soldAt || sale.soldAt || receipt.createdAt,
      offline: !!(receipt.isOffline || sale.isOffline),
      business: d.business ? d.business.name : null,
      branch: d.branch ? d.branch.name : null,
      cashier: (cashier && cashier.name) || (d.cashier && d.cashier.name) || null,
      till,
      customer: d.customer ? d.customer.name || null : null,
      currency: cur,
      items: (d.items || []).map((i) => ({ name: i.name, sku: i.sku, quantity: i.quantity, unitPrice: i.unitPrice, discount: i.discount, total: i.total })),
      subtotal: d.subtotal, tax: d.tax, total: d.total,
      payments: (d.payments || []).map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
      amountPaid: fromCents(sale.amountPaid), balance: fromCents(sale.balance), paymentStatus: sale.paymentStatus,
      saleStatus: sale.saleStatus, cancelReason: sale.cancelReason || null, cancelledAt: sale.cancelledAt || null,
      refundedQuantity: refundedQty, soldQuantity: soldQty,
    },
    scan: { previousCount: previous.count, lastScannedAt: previous.at },
  };
}

module.exports = { getReceiptBySale, recordPrint, ensureVerifyToken, verify };
