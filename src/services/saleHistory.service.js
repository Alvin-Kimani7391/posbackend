/**
 * Reports > All sales: every sale (completed AND cancelled) with many filters, plus the full detail of one sale.
 * Read-only. Money is stored as integer cents; rows and totals are converted with fromCents before they leave here.
 * Branch rule: owner / admin may look at any branch, everyone else only at the branches they are assigned to.
 */
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const User = require('../models/User');
const Customer = require('../models/Customer');
const Branch = require('../models/Branch');
const ApiError = require('../utils/ApiError');
const { fromCents: k, toCents } = require('../utils/money');
const { hasPermission } = require('../utils/permissionCheck');
const { ROLES } = require('../constants/roles');

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const terms = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
const r1 = (n) => Math.round(n * 10) / 10;
const elevated = (u) => u.role === ROLES.OWNER || u.role === ROLES.ADMIN;
const canProfit = (u) => hasPermission(u, 'reports.profit');
const PAID_PAY = ['SUCCESS', 'PARTIAL'];

/** The branches the caller may see: an explicit branchId (checked), else everything allowed (null = all). */
function branchScope(user, branchId) {
  if (branchId) {
    if (!elevated(user) && !(user.branchIds || []).some((b) => String(b) === String(branchId))) throw ApiError.forbidden('You do not have access to this branch', 'BRANCH_ACCESS_DENIED');
    return [oid(branchId)];
  }
  return elevated(user) ? null : (user.branchIds || []).map(oid);
}

async function buildFilter(businessId, user, q) {
  const bid = oid(businessId); const f = { businessId: bid }; const and = [];
  const scope = branchScope(user, q.branchId); if (scope) f.branchId = { $in: scope };
  if (q.cashierId) f.cashierId = oid(q.cashierId);
  if (q.customerId) f.customerId = oid(q.customerId);
  if (q.from || q.to) { f.soldAt = {}; if (q.from) f.soldAt.$gte = new Date(q.from); if (q.to) f.soldAt.$lte = new Date(q.to); }
  if (q.saleStatus && q.saleStatus !== 'ALL') f.saleStatus = q.saleStatus;
  const ps = csv(q.paymentStatus); if (ps.length) f.paymentStatus = { $in: ps };
  const ch = csv(q.channel); if (ch.length) f.channel = { $in: ch };
  const src = csv(q.source); if (src.length) f.source = { $in: src };
  if (q.customerType === 'WALKIN') f.customerId = null; else if (q.customerType === 'REGISTERED' && !q.customerId) f.customerId = { $exists: true, $ne: null };
  if (q.minTotal != null || q.maxTotal != null) { f.total = {}; if (q.minTotal != null) f.total.$gte = toCents(q.minTotal); if (q.maxTotal != null) f.total.$lte = toCents(q.maxTotal); }
  if (q.hasDiscount === '1') and.push({ $expr: { $gt: [{ $add: [{ $ifNull: ['$itemDiscount', 0] }, { $ifNull: ['$cartDiscount', 0] }] }, 0] } });
  if (q.hasRefund === '1') f['items.refundedQuantity'] = { $gt: 0 };
  if (q.hasBalance === '1') f.balance = { $gt: 0 };
  if (q.offline === '1') f.isOffline = true;
  if (q.flagged === '1') f.reviewStatus = 'PENDING';
  const methods = csv(q.method);
  if (methods.length) and.push({ _id: { $in: await Payment.distinct('saleId', { businessId: bid, method: { $in: methods }, status: { $in: PAID_PAY }, saleId: { $ne: null } }) } });

  // search: every word must match a receipt / invoice no., item, sku, barcode, serial, note, customer, cashier or payment reference
  for (const t of terms(q.search)) {
    const r = new RegExp(esc(t), 'i');
    const [custs, users, paid] = await Promise.all([
      Customer.distinct('_id', { businessId: bid, $or: [{ name: r }, { phone: r }] }),
      User.distinct('_id', { businessId: bid, name: r }),
      Payment.distinct('saleId', { businessId: bid, saleId: { $ne: null }, $or: [{ reference: r }, { externalTransactionId: r }] }),
    ]);
    and.push({ $or: [{ receiptNumber: r }, { invoiceNumber: r }, { 'items.nameSnapshot': r }, { 'items.skuSnapshot': r }, { 'items.barcodeSnapshot': r }, { 'items.serialNumbers': r }, { notes: r }, { cancelReason: r },
      ...(custs.length ? [{ customerId: { $in: custs } }] : []), ...(users.length ? [{ cashierId: { $in: users } }] : []), ...(paid.length ? [{ _id: { $in: paid } }] : [])] });
  }
  if (and.length) f.$and = and;
  return f;
}

const SORTS = { newest: { soldAt: -1, _id: -1 }, oldest: { soldAt: 1, _id: 1 }, highest: { total: -1, soldAt: -1 }, lowest: { total: 1, soldAt: -1 }, receipt: { receiptNumber: 1 } };
const refundedCents = (s) => (s.items || []).reduce((a, i) => (i.refundedQuantity && i.quantity ? a + Math.round((i.total / i.quantity) * i.refundedQuantity) : a), 0);

async function summary(f, user) {
  const live = { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 0, '$total'] };
  const cost = { $sum: { $map: { input: '$items', as: 'i', in: { $multiply: [{ $ifNull: ['$$i.costPriceSnapshot', 0] }, { $ifNull: ['$$i.quantity', 0] }] } } } };
  const [a] = await Sale.aggregate([{ $match: f }, { $facet: {
    tot: [{ $group: { _id: null, sales: { $sum: 1 }, cancelled: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 1, 0] } }, cancelledValue: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, '$total', 0] } },
      revenue: { $sum: live }, tax: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 0, '$tax'] } }, discount: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 0, { $add: [{ $ifNull: ['$itemDiscount', 0] }, { $ifNull: ['$cartDiscount', 0] }] }] } },
      paid: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 0, '$amountPaid'] } }, owed: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 0, { $max: ['$balance', 0] }] } },
      cost: { $sum: { $cond: [{ $eq: ['$saleStatus', 'CANCELLED'] }, 0, cost] } } } }],
    byStatus: [{ $group: { _id: '$paymentStatus', n: { $sum: 1 }, value: { $sum: live } } }],
    byChannel: [{ $group: { _id: '$channel', n: { $sum: 1 }, value: { $sum: live } } }],
    bySource: [{ $group: { _id: '$source', n: { $sum: 1 }, value: { $sum: live } } }, { $sort: { value: -1 } }],
  } }]);
  const t = (a && a.tot[0]) || {}; const done = (t.sales || 0) - (t.cancelled || 0);
  const out = {
    sales: t.sales || 0, completed: done, cancelled: t.cancelled || 0, cancelledValue: k(t.cancelledValue || 0), revenue: k(t.revenue || 0), average: done > 0 ? k(Math.round((t.revenue || 0) / done)) : 0,
    tax: k(t.tax || 0), discount: k(t.discount || 0), paid: k(t.paid || 0), owed: k(t.owed || 0),
    byPaymentStatus: ((a && a.byStatus) || []).map((x) => ({ status: x._id, sales: x.n, value: k(x.value) })),
    byChannel: ((a && a.byChannel) || []).map((x) => ({ channel: x._id, sales: x.n, value: k(x.value) })),
    bySource: ((a && a.bySource) || []).map((x) => ({ source: x._id, sales: x.n, value: k(x.value) })),
  };
  if (canProfit(user)) { out.cost = k(t.cost || 0); out.estimatedProfit = k((t.revenue || 0) - (t.tax || 0) - (t.cost || 0)); }
  return out;
}

async function list(businessId, user, q) {
  const f = await buildFilter(businessId, user, q); const page = q.page || 1, limit = q.limit || 25; const profit = canProfit(user);
  const [docs, total, sum] = await Promise.all([
    Sale.find(f).select('branchId cashierId customerId receiptNumber invoiceNumber soldAt createdAt channel source subtotal itemDiscount cartDiscount tax total amountPaid balance paymentStatus saleStatus isOffline reviewStatus notes cancelReason items.nameSnapshot items.quantity items.total items.refundedQuantity items.costPriceSnapshot')
      .sort(SORTS[q.sort] || SORTS.newest).skip((page - 1) * limit).limit(limit).lean(),
    Sale.countDocuments(f),
    page === 1 ? summary(f, user) : null,
  ]);
  const ids = docs.map((d) => d._id);
  const [users, custs, branches, pays] = await Promise.all([
    User.find({ _id: { $in: [...new Set(docs.map((d) => String(d.cashierId)))] } }).select('name').lean(),
    Customer.find({ _id: { $in: docs.map((d) => d.customerId).filter(Boolean) } }).select('name phone').lean(),
    Branch.find({ _id: { $in: [...new Set(docs.map((d) => String(d.branchId)))] } }).select('name').lean(),
    ids.length ? Payment.find({ businessId: oid(businessId), saleId: { $in: ids }, status: { $in: PAID_PAY } }).select('saleId method').lean() : [],
  ]);
  const un = new Map(users.map((x) => [String(x._id), x.name])); const cn = new Map(custs.map((x) => [String(x._id), x])); const bn = new Map(branches.map((x) => [String(x._id), x.name]));
  const pm = new Map(); pays.forEach((p) => { const s = pm.get(String(p.saleId)) || new Set(); s.add(p.method); pm.set(String(p.saleId), s); });
  const items = docs.map((s) => {
    const lines = s.items || []; const row = {
      id: s._id, receiptNumber: s.receiptNumber, invoiceNumber: s.invoiceNumber || null, soldAt: s.soldAt || s.createdAt, branchId: s.branchId, branchName: bn.get(String(s.branchId)) || '-', cashierName: un.get(String(s.cashierId)) || '-',
      customerName: s.customerId ? (cn.get(String(s.customerId)) || {}).name || 'Customer' : null, customerPhone: s.customerId ? (cn.get(String(s.customerId)) || {}).phone || null : null,
      channel: s.channel || 'RETAIL', source: s.source || 'POS', lineCount: lines.length, units: lines.reduce((a, i) => a + (i.quantity || 0), 0),
      itemNames: lines.slice(0, 3).map((i) => i.nameSnapshot), moreItems: Math.max(0, lines.length - 3),
      subtotal: k(s.subtotal || 0), discount: k((s.itemDiscount || 0) + (s.cartDiscount || 0)), tax: k(s.tax || 0), total: k(s.total || 0), amountPaid: k(s.amountPaid || 0), balance: k(s.balance || 0), refunded: k(refundedCents(s)),
      paymentStatus: s.paymentStatus, saleStatus: s.saleStatus, methods: [...(pm.get(String(s._id)) || [])], isOffline: !!s.isOffline, flagged: s.reviewStatus === 'PENDING', notes: s.notes || '', cancelReason: s.cancelReason || '',
    };
    if (profit && s.saleStatus !== 'CANCELLED') { const cost = lines.reduce((a, i) => a + (i.costPriceSnapshot || 0) * (i.quantity || 0), 0); row.cost = k(cost); row.profit = k((s.total || 0) - (s.tax || 0) - cost); }
    return row;
  });
  const out = { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
  if (sum) out.summary = sum;
  return out;
}

/** Everything about one sale: lines, every payment, refunds, who did what. */
async function detail(businessId, user, id) {
  const sale = await Sale.findOne({ _id: id, businessId })
    .populate('customerId', 'name phone email').populate('cashierId', 'name').populate('branchId', 'name code').populate('cancelledBy', 'name').populate('reviewedBy', 'name');
  if (!sale) throw ApiError.notFound('Sale not found');
  branchScope(user, sale.branchId && sale.branchId._id ? sale.branchId._id : sale.branchId);
  const [payments, refunds] = await Promise.all([
    Payment.find({ businessId, saleId: sale._id }).sort({ createdAt: 1 }),
    Refund.find({ businessId, saleId: sale._id }).sort({ createdAt: 1 }).populate('requestedBy', 'name').populate('approvedBy', 'name'),
  ]);
  const s = sale.toJSON(); const profit = canProfit(user);
  if (!profit) (s.items || []).forEach((i) => { delete i.costPriceSnapshot; delete i.wholesaleValueSnapshot; });
  return { sale: s, payments: payments.map((p) => p.toJSON()), refunds: refunds.map((r) => r.toJSON()), canSeeProfit: profit };
}

module.exports = { list, detail };
