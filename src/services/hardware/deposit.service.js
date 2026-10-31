/** Customer deposits against a project / order. A deposit is money held for the customer, not a sale. It is spent when an order is invoiced. Money = integer cents. */
const CustomerDeposit = require('../../models/CustomerDeposit');
const Customer = require('../../models/Customer');
const Project = require('../../models/Project');
const AuditLog = require('../../models/AuditLog');
const { nextSequence, pad } = require('../../models/Counter');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');
const money = (c) => fromCents(Math.round(c || 0));

async function create(businessId, user, input) {
  assertBranchAccess(user, input.branchId);
  if (!(await Customer.exists({ _id: input.customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  if (input.projectId && !(await Project.exists({ _id: input.projectId, businessId, customerId: input.customerId }))) throw ApiError.badRequest('That project is not this customer\'s', 'PROJECT_MISMATCH');
  if (input.method !== 'CASH' && !input.reference) throw ApiError.badRequest('A transaction reference is required', 'REFERENCE_REQUIRED');
  try {
    const d = await CustomerDeposit.create({ businessId, branchId: input.branchId, customerId: input.customerId, projectId: input.projectId, quotationId: input.quotationId, number: `DEP-${pad(await nextSequence(businessId, 'hardware:deposit'))}`, amount: input.amount, balance: input.amount, method: input.method, reference: input.reference, notes: input.notes, createdBy: user._id });
    await AuditLog.create({ businessId, branchId: d.branchId, userId: user._id, action: 'hardware.deposit.create', entityType: 'CustomerDeposit', entityId: d._id, newValue: { amount: d.amount, reference: d.reference } }); return d;
  } catch (e) { if (e.code === 11000) throw ApiError.conflict('This transaction reference was already recorded', 'DUPLICATE_REFERENCE'); throw e; }
}
async function list(businessId, { customerId, projectId, status, page = 1, limit = 50 }) {
  const q = { businessId }; if (customerId) q.customerId = customerId; if (projectId) q.projectId = projectId; if (status) q.status = status;
  const [rows, total] = await Promise.all([CustomerDeposit.find(q).populate('customerId', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), CustomerDeposit.countDocuments(q)]);
  const held = rows.reduce((s, r) => s + (r.status === 'OPEN' ? r.balance : 0), 0); return { total, page, rows, heldOnPage: money(held) };
}
async function refund(businessId, user, id, { amount, reason }) {
  const r = await CustomerDeposit.findOneAndUpdate({ _id: id, businessId, status: 'OPEN', balance: { $gte: amount } }, { $inc: { balance: -amount }, $push: { refunds: { amount, reason, at: new Date(), by: user._id } } }, { new: true });
  if (!r) throw ApiError.conflict('Deposit not found, closed, or the refund is more than the balance left', 'CANNOT_REFUND');
  if (r.balance === 0) { r.status = 'REFUNDED'; await r.save(); }
  await AuditLog.create({ businessId, branchId: r.branchId, userId: user._id, action: 'hardware.deposit.refund', entityType: 'CustomerDeposit', entityId: r._id, newValue: { amount, reason } }); return r;
}
/** Take money out of deposits (atomic per deposit) and return the payment lines for the sale. Call release() if the sale then fails. */
async function reserve(businessId, customerId, uses) {
  const taken = [];
  try {
    for (const u of uses) {
      const r = await CustomerDeposit.findOneAndUpdate({ _id: u.depositId, businessId, customerId, status: 'OPEN', balance: { $gte: u.amount } }, { $inc: { balance: -u.amount } }, { new: true });
      if (!r) throw ApiError.conflict('A deposit is missing, belongs to another customer, or has less left than requested', 'DEPOSIT_UNAVAILABLE');
      taken.push({ ...u, number: r.number });
    }
  } catch (e) { await release(businessId, taken); throw e; }
  return { taken, payments: taken.map((t) => ({ method: 'OTHER', amount: t.amount, reference: t.number })) };
}
async function release(businessId, taken) { for (const t of taken) await CustomerDeposit.updateOne({ _id: t.depositId, businessId }, { $inc: { balance: t.amount } }).catch((e) => console.error('could not return deposit', t.number, e.message)); }
async function commit(businessId, taken, saleId) {
  for (const t of taken) { const d = await CustomerDeposit.findOneAndUpdate({ _id: t.depositId, businessId }, { $push: { applications: { saleId, amount: t.amount, at: new Date() } } }, { new: true }); if (d && d.balance === 0 && d.status === 'OPEN') { d.status = 'USED'; await d.save(); } }
}
async function summary(businessId, customerId) {
  const rows = await CustomerDeposit.find({ businessId, customerId, status: 'OPEN' }).select('number balance projectId createdAt').lean();
  return { held: money(rows.reduce((s, r) => s + r.balance, 0)), deposits: rows.map((r) => ({ id: r._id, number: r.number, balance: money(r.balance), projectId: r.projectId })) };
}
module.exports = { create, list, refund, reserve, release, commit, summary };
