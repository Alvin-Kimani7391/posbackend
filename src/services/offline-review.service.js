'use strict';
const Sale = require('../models/Sale');
const Device = require('../models/Device');
const CashShift = require('../models/CashShift');
const Business = require('../models/Business');
const SyncRejection = require('../models/SyncRejection');
const OfflineMpesaClaim = require('../models/OfflineMpesaClaim');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const { REGISTRY } = require('./offline-events');
const { verifyGrantForDevice, IngestRejection } = require('./offline-sale.service');

const isOwnerOrAdmin = (u) => u.role === ROLES.OWNER || u.role === ROLES.ADMIN;

/* ----------------------------- sales needing review ----------------------------- */

async function listReviewSales(businessId, { status, branchId, page = 1, limit = 20 }) {
  const filter = { businessId, isOffline: true, reviewStatus: status || 'PENDING' };
  if (branchId) filter.branchId = branchId;
  const [items, total] = await Promise.all([
    Sale.find(filter)
      .populate('cashierId', 'name')
      .populate('branchId', 'name code')
      .sort({ soldAt: -1 }).skip((page - 1) * limit).limit(limit),
    Sale.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function resolveSale(businessId, user, saleId, note) {
  const sale = await Sale.findOne({ _id: saleId, businessId, isOffline: true });
  if (!sale) throw ApiError.notFound('Sale not found');
  if (sale.reviewStatus !== 'PENDING') throw ApiError.conflict('This sale is not waiting for review', 'NOT_PENDING_REVIEW');
  if (String(sale.cashierId) === String(user._id) && user.role !== ROLES.OWNER) {
    throw ApiError.forbidden('You cannot review a sale you made yourself', 'SELF_REVIEW_NOT_ALLOWED');
  }
  const waiting = await OfflineMpesaClaim.exists({ saleId: sale._id, status: 'PENDING_REVIEW' });
  if (waiting) throw ApiError.conflict('Decide the pending M-PESA payment on this sale first', 'MPESA_CLAIM_PENDING');

  sale.reviewStatus = 'RESOLVED';
  sale.reviewedBy = user._id;
  sale.reviewedAt = new Date();
  sale.reviewNote = note;
  await sale.save();
  await AuditLog.create({ businessId, branchId: sale.branchId, userId: user._id, action: 'offline.sale.review', entityType: 'Sale', entityId: sale._id, newValue: { note, flags: (sale.reviewFlags || []).map((f) => f.code) } });
  return sale;
}

/* ----------------------------- quarantine ----------------------------- */

async function listRejections(businessId, { status, page = 1, limit = 20 }) {
  const filter = { businessId, status: status || { $in: ['HELD', 'REJECTED'] } };
  const [items, total] = await Promise.all([
    SyncRejection.find(filter).select('-payload').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    SyncRejection.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getRejection(businessId, id) {
  const r = await SyncRejection.findOne({ _id: id, businessId }).lean();
  if (!r) throw ApiError.notFound('Held sale not found');
  if (r.payload) r.payload = { ...r.payload, grant: r.payload.grant ? '[signed grant kept on file]' : undefined };
  return r;
}

/** Force-accepts a held/rejected sale. The sale is recorded with HIGH flags so it stays visible to reviewers. */
async function releaseRejection(businessId, user, id, note) {
  const rej = await SyncRejection.findOne({ _id: id, businessId });
  if (!rej) throw ApiError.notFound('Held sale not found');
  if (!['HELD', 'REJECTED'].includes(rej.status)) throw ApiError.conflict('This sale has already been dealt with', 'ALREADY_RESOLVED');
  if (!rej.releasable) throw ApiError.conflict(`This sale cannot be accepted (${rej.code}). It can only be discarded.`, 'NOT_RELEASABLE');

  const [business, device] = await Promise.all([
    Business.findById(businessId),
    Device.findOne({ businessId, deviceId: rej.deviceId }),
  ]);
  if (!business || !device) throw ApiError.notFound('Business or device not found');

  const entry = REGISTRY[rej.eventType || 'SALE'];
  if (!entry) throw ApiError.badRequest('Unknown event type', 'PAYLOAD_INVALID');
  const parsed = entry.schema.safeParse(rej.payload);
  if (!parsed.success) throw ApiError.badRequest('The stored data is malformed and cannot be accepted', 'PAYLOAD_INVALID');

  let claims;
  let result;
  try {
    claims = verifyGrantForDevice(parsed.data.grant, businessId, device);
    if (String(claims.sub) === String(user._id) && user.role !== ROLES.OWNER) {
      throw ApiError.forbidden('You cannot release an item you created yourself', 'SELF_REVIEW_NOT_ALLOWED');
    }
    result = await entry.run({ business, device, claims, data: parsed.data, syncedAt: new Date(), skewMs: 0, force: true });
  } catch (err) {
    if (err instanceof IngestRejection) throw ApiError.conflict(err.message, err.code);
    throw err;
  }

  rej.status = 'RELEASED';
  rej.resolvedBy = user._id;
  rej.resolvedAt = new Date();
  rej.resolutionNote = note;
  rej.resultSaleId = result.saleId;
  await rej.save();

  await AuditLog.create({ businessId, branchId: rej.branchId, userId: user._id, action: 'offline.rejection.release', entityType: 'SyncRejection', entityId: rej._id, newValue: { code: rej.code, saleId: result.saleId, note } });
  return { rejection: rej, result };
}

async function discardRejection(businessId, user, id, reason) {
  if (!isOwnerOrAdmin(user)) throw ApiError.forbidden('Only the owner or an admin can discard a sale', 'OWNER_REQUIRED');
  const rej = await SyncRejection.findOneAndUpdate(
    { _id: id, businessId, status: { $in: ['HELD', 'REJECTED'] } },
    { $set: { status: 'DISCARDED', resolvedBy: user._id, resolvedAt: new Date(), resolutionNote: reason } }, // payload is KEPT as evidence
    { new: true }
  );
  if (!rej) throw ApiError.notFound('Held sale not found or already dealt with');
  await AuditLog.create({ businessId, branchId: rej.branchId, userId: user._id, action: 'offline.rejection.discard', entityType: 'SyncRejection', entityId: rej._id, newValue: { code: rej.code, reason } });
  return rej;
}

/* ----------------------------- gap detection ----------------------------- */

/** Local receipt numbers the server never received for a device (lost data or deleted sales). */
async function detectGaps(businessId, deviceId) {
  const device = await Device.findOne({ businessId, deviceId }).select('deviceCode highestLocalSeq');
  if (!device) throw ApiError.notFound('Device not found');

  const [sales, held] = await Promise.all([
    Sale.find({ businessId, deviceId, localSeq: { $type: 'number' } }).select('localSeq').limit(200000).lean(),
    SyncRejection.find({ businessId, deviceId, localSeq: { $type: 'number' } }).select('localSeq').limit(50000).lean(),
  ]);
  const seen = new Set([...sales.map((s) => s.localSeq), ...held.map((h) => h.localSeq)]);
  const max = Math.max(device.highestLocalSeq || 0, ...seen);
  const missing = [];
  for (let n = 1; n <= max && missing.length < 500; n += 1) if (!seen.has(n)) missing.push(n);
  return { deviceCode: device.deviceCode, highestLocalSeq: max, received: seen.size, missing };
}

/* ----------------------------- offline shifts needing review ----------------------------- */

async function listReviewShifts(businessId, { status, branchId, page = 1, limit = 20 }) {
  const filter = { businessId, offlineReview: status || 'PENDING' };
  if (branchId) filter.branchId = branchId;
  const [items, total] = await Promise.all([
    CashShift.find(filter).populate('cashierId', 'name').populate('registerId', 'name code').populate('branchId', 'name').sort({ openedAt: -1 }).skip((page - 1) * limit).limit(limit),
    CashShift.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function resolveShift(businessId, user, id, note) {
  const shift = await CashShift.findOneAndUpdate(
    { _id: id, businessId, offlineReview: 'PENDING' },
    { $set: { offlineReview: 'RESOLVED', offlineReviewedBy: user._id, offlineReviewedAt: new Date(), offlineReviewNote: note } },
    { new: true }
  );
  if (!shift) throw ApiError.notFound('Shift not found or not waiting for review');
  await AuditLog.create({ businessId, branchId: shift.branchId, userId: user._id, action: 'offline.shift.review', entityType: 'CashShift', entityId: shift._id, newValue: { note, flags: (shift.offlineFlags || []).map((f) => f.code) } });
  return shift;
}

/** One call for the manager's badge counts. */
async function getSummary(businessId) {
  const quiet = new Date(Date.now() - 6 * 3600 * 1000);
  const [pendingSales, pendingMpesa, heldItems, pendingShifts, staleTills] = await Promise.all([
    Sale.countDocuments({ businessId, isOffline: true, reviewStatus: 'PENDING' }),
    OfflineMpesaClaim.countDocuments({ businessId, status: 'PENDING_REVIEW' }),
    SyncRejection.countDocuments({ businessId, status: { $in: ['HELD', 'REJECTED'] } }),
    CashShift.countDocuments({ businessId, offlineReview: 'PENDING' }),
    Device.countDocuments({ businessId, status: 'active', offlineEnabled: true, lastPendingCount: { $gt: 0 }, lastSeenAt: { $lt: quiet } }),
  ]);
  return { pendingSales, pendingMpesa, heldItems, pendingShifts, staleTills, total: pendingSales + pendingMpesa + heldItems + pendingShifts };
}

module.exports = { listReviewShifts, resolveShift, getSummary, listReviewSales, resolveSale, listRejections, getRejection, releaseRejection, discardRejection, detectGaps };