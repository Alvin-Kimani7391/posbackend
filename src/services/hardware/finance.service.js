/** Hardware finance: operating profit with every cost counted once, expense classification, budgets and recurring costs. Money = integer cents. */
const mongoose = require('mongoose');
const Sale = require('../../models/Sale');
const Expense = require('../../models/Expense');
const DeliveryOrder = require('../../models/DeliveryOrder');
const TransportCost = require('../../models/TransportCost');
const LandedCost = require('../../models/LandedCost');
const ExpenseBudget = require('../../models/ExpenseBudget');
const RecurringExpense = require('../../models/RecurringExpense');
const AuditLog = require('../../models/AuditLog');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');
const oid = (v) => new mongoose.Types.ObjectId(String(v)); const money = (c) => fromCents(Math.round(c || 0));
const dr = (from, to, f) => (from || to ? { [f]: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {});

/** pure: operating profit. Everything is cents. transport revenue and costs appear once; carve-outs stop an expense being counted twice. */
function operatingProfit({ netSales, cogs, deliveryRevenue = 0, transportCosts = 0, landedCosts = 0, operatingExpenses = 0, allocatedFromExpenses = 0, otherIncome = 0 }) {
  const opExNet = operatingExpenses - allocatedFromExpenses; if (opExNet < 0) throw new Error('Allocated more than the expenses recorded');
  const grossProfit = netSales - cogs;
  return { grossProfit, opExNet, operatingProfit: grossProfit + deliveryRevenue + otherIncome - transportCosts - landedCosts - opExNet };
}
/** pure: next date for a recurring cost */
function nextDate(d, freq) { const x = new Date(d); if (freq === 'WEEKLY') x.setDate(x.getDate() + 7); else { const day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + ({ MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 }[freq])); x.setDate(Math.min(day, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); } return x; }

async function report(businessId, user, { from, to, branchId }) {
  if (branchId) assertBranchAccess(user, branchId); const b = branchId ? { branchId: oid(branchId) } : {};
  const sm = { businessId: oid(businessId), saleStatus: 'COMPLETED', ...b, ...dr(from, to, 'soldAt') };
  const [s] = await Sale.aggregate([{ $match: sm }, { $unwind: '$items' }, { $addFields: { keep: { $cond: [{ $gt: ['$items.quantity', 0] }, { $divide: [{ $subtract: ['$items.quantity', { $ifNull: ['$items.refundedQuantity', 0] }] }, '$items.quantity'] }, 0] } } }, { $group: { _id: null, net: { $sum: { $multiply: [{ $subtract: ['$items.total', { $ifNull: ['$items.taxAmount', 0] }] }, '$keep'] } }, cogs: { $sum: { $multiply: ['$items.costPriceSnapshot', '$items.quantity', '$keep'] } }, tax: { $sum: { $multiply: [{ $ifNull: ['$items.taxAmount', 0] }, '$keep'] } } } }]);
  const [dl] = await DeliveryOrder.aggregate([{ $match: { businessId: oid(businessId), status: 'DELIVERED', 'pricing.absorbed': { $ne: true }, ...b, ...dr(from, to, 'arrivedAt') } }, { $group: { _id: null, rev: { $sum: '$charge' }, n: { $sum: 1 } } }]);
  const tcs = await TransportCost.aggregate([{ $match: { businessId: oid(businessId), voided: false, ...b, ...dr(from, to, 'date') } }, { $group: { _id: { job: { $cond: [{ $ifNull: ['$deliveryId', false] }, 'JOB', 'VEHICLE'] } }, t: { $sum: '$amount' } } }]);
  const tc = Object.fromEntries(tcs.map((x) => [x._id.job, x.t]));
  const [lc] = await LandedCost.aggregate([{ $match: { businessId: oid(businessId), voided: false, ...dr(from, to, 'date') } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
  const ex = await Expense.find({ businessId, status: 'APPROVED', ...b, ...dr(from, to, 'expenseDate') }).select('amount kind').lean();
  const byKind = {}; ex.forEach((e) => { const k = e.kind || 'OPERATING'; byKind[k] = (byKind[k] || 0) + e.amount; });
  const opIds = ex.filter((e) => (e.kind || 'OPERATING') === 'OPERATING').map((e) => e._id);
  const [a1] = await TransportCost.aggregate([{ $match: { businessId: oid(businessId), voided: false, expenseId: { $in: opIds } } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
  const [a2] = await LandedCost.aggregate([{ $match: { businessId: oid(businessId), voided: false, expenseId: { $in: opIds } } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
  const pl = operatingProfit({ netSales: s?.net || 0, cogs: s?.cogs || 0, deliveryRevenue: dl?.rev || 0, transportCosts: (tc.JOB || 0) + (tc.VEHICLE || 0), landedCosts: lc?.t || 0, operatingExpenses: byKind.OPERATING || 0, allocatedFromExpenses: (a1?.t || 0) + (a2?.t || 0) });
  return { period: { from, to }, netSales: money(s?.net), costOfGoodsSold: money(s?.cogs), grossProfit: money(pl.grossProfit), vatCollected: money(s?.tax), deliveryRevenue: money(dl?.rev), transportDirectJobCosts: money(tc.JOB), transportVehicleCosts: money(tc.VEHICLE), landedCosts: money(lc?.t),
    operatingExpenses: { recorded: money(byKind.OPERATING), alreadyCountedAsTransportOrLanded: money((a1?.t || 0) + (a2?.t || 0)), net: money(pl.opExNet) }, operatingProfit: money(pl.operatingProfit),
    outsideOperatingProfit: { inventoryPurchases: money(byKind.INVENTORY), capitalPurchases: money(byKind.CAPITAL), loanRepayments: money(byKind.LOAN_REPAYMENT), ownerWithdrawals: money(byKind.OWNER_WITHDRAWAL) },
    notes: ['Net sales are before VAT and after refunds. VAT collected is not income.', 'An expense linked to a transport job or a purchase is counted once, in its own line.', 'Landed costs are shown here but not yet added into stock cost, so cost of goods sold excludes them.'] };
}
async function classify(businessId, user, id, { kind, payee, dueDate, paid }) {
  const e = await Expense.findOne({ _id: id, businessId }); if (!e) throw ApiError.notFound('Expense not found'); assertBranchAccess(user, e.branchId);
  if (kind && kind !== (e.kind || 'OPERATING') && (await TransportCost.exists({ expenseId: id, voided: false }) || await LandedCost.exists({ expenseId: id, voided: false }))) throw ApiError.conflict('This expense is allocated to a job or purchase. Void the allocation first.', 'ALLOCATED');
  if (kind) e.kind = kind; if (payee !== undefined) e.payee = payee; if (dueDate !== undefined) e.dueDate = dueDate; if (paid === true) e.paidAt = new Date(); if (paid === false) e.paidAt = undefined;
  await e.save(); await AuditLog.create({ businessId, branchId: e.branchId, userId: user._id, action: 'hardware.expense.classify', entityType: 'Expense', entityId: e._id, newValue: { kind, dueDate, paid } }); return e;
}
async function unpaidBills(businessId, user, { branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const rows = await Expense.find({ businessId, status: 'APPROVED', dueDate: { $ne: null }, paidAt: null, ...(branchId ? { branchId } : {}) }).sort({ dueDate: 1 }).limit(300).lean();
  return rows.map((e) => ({ id: e._id, category: e.category, payee: e.payee, amount: money(e.amount), dueDate: e.dueDate, overdue: e.dueDate < new Date() }));
}
async function setBudgets(businessId, user, { branchId, month, items }) {
  if (branchId) assertBranchAccess(user, branchId);
  for (const i of items) await ExpenseBudget.updateOne({ businessId, branchId: branchId || null, month, category: i.category }, { $set: { amount: i.amount } }, { upsert: true });
  await AuditLog.create({ businessId, userId: user._id, action: 'hardware.budget.set', entityType: 'ExpenseBudget', newValue: { month, count: items.length } }); return budgetVsActual(businessId, user, { branchId, month });
}
async function budgetVsActual(businessId, user, { branchId, month }) {
  if (branchId) assertBranchAccess(user, branchId); const [y, m] = month.split('-').map(Number); const from = new Date(y, m - 1, 1); const to = new Date(y, m, 1);
  const budgets = await ExpenseBudget.find({ businessId, branchId: branchId || null, month }).lean();
  const act = await Expense.aggregate([{ $match: { businessId: oid(businessId), status: 'APPROVED', ...(branchId ? { branchId: oid(branchId) } : {}), expenseDate: { $gte: from, $lt: to }, kind: { $in: ['OPERATING', null] } } }, { $group: { _id: '$category', t: { $sum: '$amount' } } }]);
  const A = new Map(act.map((x) => [x._id, x.t])); const cats = new Set([...budgets.map((x) => x.category), ...A.keys()]); const B = new Map(budgets.map((x) => [x.category, x.amount]));
  const rows = [...cats].map((c) => { const bud = B.get(c) || 0; const a = A.get(c) || 0; return { category: c, budget: money(bud), actual: money(a), variance: money(bud - a), overBudget: bud > 0 ? a > bud : a > 0 && !B.has(c) }; }).sort((x, y) => x.category.localeCompare(y.category));
  return { month, rows, totalBudget: money([...B.values()].reduce((s, v) => s + v, 0)), totalActual: money([...A.values()].reduce((s, v) => s + v, 0)) };
}
async function createRecurring(businessId, user, input) { assertBranchAccess(user, input.branchId); const r = await RecurringExpense.create({ ...input, businessId, createdBy: user._id }); await AuditLog.create({ businessId, branchId: r.branchId, userId: user._id, action: 'hardware.recurring.create', entityType: 'RecurringExpense', entityId: r._id }); return r; }
async function listRecurring(businessId) { return RecurringExpense.find({ businessId }).sort({ nextDue: 1 }).limit(200); }
async function stopRecurring(businessId, user, id) { const r = await RecurringExpense.findOneAndUpdate({ _id: id, businessId }, { active: false }, { new: true }); if (!r) throw ApiError.notFound('Recurring expense not found'); return r; }
/** Create the expenses that have come due. Safe to run twice: each period is claimed before it is created. Created as PENDING so the normal approval flow applies. */
async function runRecurring(businessId, user, asOf = new Date()) {
  const due = await RecurringExpense.find({ businessId, active: true, nextDue: { $lte: asOf } }); let created = 0;
  for (const r of due) {
    for (let n = 0; n < 12 && r.nextDue <= asOf && (!r.endsOn || r.nextDue <= r.endsOn); n++) {
      const next = nextDate(r.nextDue, r.frequency); const claim = await RecurringExpense.updateOne({ _id: r._id, nextDue: r.nextDue }, { $set: { nextDue: next } }); if (!claim.modifiedCount) break;
      await Expense.create({ businessId, branchId: r.branchId, category: r.category, amount: r.amount, description: r.description || `Recurring ${r.category}`, expenseDate: r.nextDue, kind: r.kind || 'OPERATING', payee: r.payee, createdBy: user._id }); created++; r.nextDue = next;
    }
    if (r.endsOn && r.nextDue > r.endsOn) await RecurringExpense.updateOne({ _id: r._id }, { $set: { active: false } });
  }
  return { created };
}
module.exports = { operatingProfit, nextDate, report, classify, unpaidBills, setBudgets, budgetVsActual, createRecurring, listRecurring, stopRecurring, runRecurring };
