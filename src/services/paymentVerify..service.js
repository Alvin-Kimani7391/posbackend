/** Manager / owner verification of mobile-money payments recorded by message code (restaurant bills and stays). */
const RestaurantBill = require('../models/RestaurantBill');
const Stay = require('../models/Stay');
const Payment = require('../models/Payment');
const ApiError = require('../utils/ApiError');
const AuditLog = require('../models/AuditLog');
const C = require('./restaurant/common');
const { fromCents } = require('../utils/money');
const PENDING_FILTER = { $elemMatch: { method: 'MOBILE_MONEY', kind: { $ne: 'REFUND' }, verifyStatus: 'PENDING' } };
const row = (kind, doc, p) => ({
  kind, docId: doc._id, entryId: p._id, number: kind === 'BILL' ? doc.billNumber : doc.stayNumber,
  label: kind === 'BILL' ? (doc.tableName ? `Table ${doc.tableName}` : (doc.orderType || '').replace('_', ' ')) : `${doc.guest?.name || 'Guest'}${doc.roomNumber ? ' · Room ' + doc.roomNumber : ''}`,
  method: p.method, network: p.network, payerPhone: p.payerPhone, reference: p.reference, amount: fromCents(p.amount), at: p.at, by: p.by, verifyStatus: p.verifyStatus, verifyNote: p.verifyNote,
});
async function listUnverified(businessId, user, { branchId, limit = 50 }, { restaurant = true, accommodation = true } = {}) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  const [bills, stays] = await Promise.all([
    restaurant ? RestaurantBill.find({ ...f, payments: PENDING_FILTER }).select('billNumber tableName orderType payments').sort({ updatedAt: -1 }).limit(limit) : [],
    accommodation ? Stay.find({ ...f, payments: PENDING_FILTER }).select('stayNumber guest roomNumber payments').sort({ updatedAt: -1 }).limit(limit) : [],
  ]);
  const out = [];
  for (const d of bills) for (const p of d.payments) if (p.method === 'MOBILE_MONEY' && p.verifyStatus === 'PENDING' && p.kind !== 'REFUND') out.push(row('BILL', d, p));
  for (const d of stays) for (const p of d.payments) if (p.method === 'MOBILE_MONEY' && p.verifyStatus === 'PENDING' && p.kind !== 'REFUND') out.push(row('STAY', d, p));
  return out.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}
async function verify(Model, kind, businessId, user, id, entryId, { approve, note }) {
  const doc = await Model.findOne({ _id: id, businessId }); if (!doc) throw ApiError.notFound(kind === 'BILL' ? 'Bill not found' : 'Stay not found');
  C.assertBranchAccess(user, doc.branchId);
  const p = doc.payments.id(entryId); if (!p) throw ApiError.notFound('Payment not found');
  if (p.method !== 'MOBILE_MONEY') throw ApiError.badRequest('Only mobile-money payments need verifying', 'NOT_MOBILE_MONEY');
  if (p.verifyStatus !== 'PENDING') throw ApiError.conflict(`This payment is already ${String(p.verifyStatus || '').toLowerCase()}`, 'ALREADY_VERIFIED');
  if (!approve && (!note || note.trim().length < 3)) throw ApiError.badRequest('Say why the payment could not be verified', 'NOTE_REQUIRED');
  p.verifyStatus = approve ? 'VERIFIED' : 'REJECTED'; p.verified = !!approve; p.verifiedBy = user._id; p.verifiedAt = new Date(); p.verifyNote = note;
  doc.history.push({ at: new Date(), action: approve ? 'payment.verified' : 'payment.rejected', by: user._id, note: `${p.network || ''} ${p.reference || ''} ${note || ''}`.trim() });
  await doc.save();
  if (p.paymentId) await Payment.updateOne({ _id: p.paymentId, businessId }, { $set: { 'metadata.verifyStatus': p.verifyStatus, 'metadata.verifiedBy': user._id, 'metadata.verifiedAt': p.verifiedAt, 'metadata.verifyNote': note || null } });
  await AuditLog.create({ businessId, branchId: doc.branchId, userId: user._id, action: approve ? 'payment.mobile_money.verified' : 'payment.mobile_money.rejected', entityType: kind === 'BILL' ? 'RestaurantBill' : 'Stay', entityId: doc._id, newValue: { reference: p.reference, network: p.network, amount: p.amount, note } });
  if (!approve) C.notifyRoles(businessId, doc.branchId, [...C.FLOOR_LEAD_ROLES], { type: 'PAYMENT_REJECTED', title: 'Mobile-money payment not verified', message: `${kind === 'BILL' ? doc.billNumber : doc.stayNumber}: ${p.network || 'Mobile money'} ${p.reference || ''} - ${note}`, entityType: kind === 'BILL' ? 'RestaurantBill' : 'Stay', entityId: doc._id });
  return row(kind, doc, p);
}
module.exports = { listUnverified,
  verifyBill: (b, u, id, e, body) => verify(RestaurantBill, 'BILL', b, u, id, e, body),
  verifyStay: (b, u, id, e, body) => verify(Stay, 'STAY', b, u, id, e, body) };
