const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const Expense = require('../models/Expense');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Business = require('../models/Business');
const BranchInventory = require('../models/BranchInventory');
const LocationTransfer = require('../models/LocationTransfer');
const { fromCents } = require('../utils/money');
const { getLowStockAlerts } = require('./inventory.service');

/**
 * toObjectId - Mongoose casts string ids to ObjectId automatically for
 * Model.find()/.distinct()/.findOne() etc, but NOT for Model.aggregate(),
 * which sends the $match stage to MongoDB as-is. If a caller's id (e.g.
 * req.user._id from a JWT payload) is a plain string, an aggregate $match
 * on an ObjectId-typed field silently matches nothing - no error, just an
 * empty result. Every id that reaches an aggregate() pipeline in this file
 * is wrapped in this first so string vs ObjectId can never cause a silent
 * zero (this was the root cause of "my sales show 0" for cashiers).
 */
function toObjectId(id) {
  if (!id) return id;
  if (id instanceof mongoose.Types.ObjectId) return id;
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return id; // let it fail naturally downstream rather than throw here
  }
}

function resolveDateRange(from, to) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { $gte: start, $lte: end };
}

function saleMatch({ businessId, branchId, cashierId, from, to }) {
  const match = { businessId: toObjectId(businessId), saleStatus: 'COMPLETED', soldAt: resolveDateRange(from, to) };
  if (branchId) match.branchId = toObjectId(branchId);
  if (cashierId) match.cashierId = toObjectId(cashierId);
  return match;
}

/** Sum of (unitPrice * refundedQuantity) across a sale's items, using the
 * per-line total/quantity actually charged - not today's product price. */
function computeRefundedAmountCents(sale) {
  return (sale.items || []).reduce((sum, i) => {
    if (!i.refundedQuantity) return sum;
    const unit = i.quantity ? i.total / i.quantity : 0;
    return sum + Math.round(unit * i.refundedQuantity);
  }, 0);
}

async function getSalesReport(businessId, { branchId, cashierId, from, to }) {
  const match = saleMatch({ businessId, branchId, cashierId, from, to });

  const [totals] = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalSales: { $sum: '$subtotal' },
        transactionCount: { $sum: 1 },
        totalDiscount: { $sum: { $add: ['$itemDiscount', '$cartDiscount'] } },
        totalTax: { $sum: '$tax' },
        netSales: { $sum: '$total' },
      },
    },
  ]);

  // .find()/.distinct() cast query values through the schema automatically,
  // so `match` (already-cast ObjectIds from saleMatch) works here regardless.
  const saleIds = await Sale.find(match).distinct('_id');
  const paymentBreakdownRaw = await Payment.aggregate([
    { $match: { businessId: toObjectId(businessId), saleId: { $in: saleIds }, status: 'SUCCESS' } },
    { $group: { _id: '$method', total: { $sum: '$amount' } } },
  ]);

  const refundAgg = await Refund.aggregate([
    { $match: { businessId: toObjectId(businessId), saleId: { $in: saleIds }, status: 'COMPLETED' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const topProductsRaw = await Sale.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', name: { $first: '$items.nameSnapshot' }, quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
  ]);

  const dailyTrend = await getSalesTrend(businessId, { branchId, cashierId, from, to });

  const t = totals || { totalSales: 0, transactionCount: 0, totalDiscount: 0, totalTax: 0, netSales: 0 };
  return {
    totalSales: fromCents(t.totalSales),
    transactionCount: t.transactionCount,
    totalDiscount: fromCents(t.totalDiscount),
    totalTax: fromCents(t.totalTax),
    totalRefunds: fromCents(refundAgg[0]?.total || 0),
    netSales: fromCents(t.netSales),
    paymentBreakdown: paymentBreakdownRaw.map((p) => ({ method: p._id, total: fromCents(p.total) })),
    topProducts: topProductsRaw.map((p) => ({ productId: p._id, name: p.name, quantity: p.quantity, revenue: fromCents(p.revenue) })),
    dailyTrend,
  };
}

/**
 * getSalesTrend - net sales and transaction count grouped by calendar day,
 * in the BUSINESS'S OWN timezone (business.timezone, default
 * Africa/Nairobi) rather than UTC, so "today" on the chart matches what
 * the shop actually experienced as today. Returns oldest-first.
 */
async function getSalesTrend(businessId, { branchId, cashierId, from, to }) {
  const match = saleMatch({ businessId, branchId, cashierId, from, to });
  const business = await Business.findById(businessId).select('timezone');
  const timezone = business?.timezone || 'Africa/Nairobi';

  const rows = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt', timezone } },
        netSales: { $sum: '$total' },
        transactionCount: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  return rows.map((r) => ({ date: r._id, netSales: fromCents(r.netSales), transactionCount: r.transactionCount }));
}

/**
 * getSalesDetail - the actual sales behind a Sales-report KPI, for the
 * "expand" drill-downs. Unlike GET /sales, this returns the broken-out
 * figures a KPI tile needs (tax, discount, refunded amount) alongside
 * branch/cashier/customer names, so "Tax collected -> expand" genuinely
 * shows each sale's tax, not just a generic transaction list.
 *
 *   hasDiscount=true -> only sales where itemDiscount+cartDiscount > 0
 *   hasRefund=true   -> only sales with at least one refunded line
 */
async function getSalesDetail(businessId, { branchId, cashierId, from, to, hasDiscount, hasRefund, page = 1, limit = 20 }) {
  const match = saleMatch({ businessId, branchId, cashierId, from, to });
  if (hasDiscount) match.$expr = { $gt: [{ $add: ['$itemDiscount', '$cartDiscount'] }, 0] };
  if (hasRefund) match['items.refundedQuantity'] = { $gt: 0 };

  const [docs, total] = await Promise.all([
    Sale.find(match)
      .populate('customerId', 'name')
      .populate('cashierId', 'name')
      .populate('branchId', 'name')
      .sort({ soldAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Sale.countDocuments(match),
  ]);

  const items = docs.map((s) => ({
    id: s._id,
    receiptNumber: s.receiptNumber,
    createdAt: s.soldAt || s.createdAt,
    branchName: s.branchId?.name || null,
    cashierName: s.cashierId?.name || null,
    customerName: s.customerId?.name || null,
    subtotal: fromCents(s.subtotal),
    totalDiscount: fromCents((s.itemDiscount || 0) + (s.cartDiscount || 0)),
    tax: fromCents(s.tax),
    total: fromCents(s.total),
    refundedAmount: fromCents(computeRefundedAmountCents(s)),
    paymentStatus: s.paymentStatus,
    saleStatus: s.saleStatus,
  }));

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * getPaymentsDetail - individual payment records for the Payments-report
 * drill-downs. Shows branch, method, reference and status per payment,
 * with the receipt/cashier of the sale it belongs to where available.
 */
async function getPaymentsDetail(businessId, { branchId, from, to, method, status, page = 1, limit = 20 }) {
  const match = { businessId: toObjectId(businessId), createdAt: resolveDateRange(from, to) };
  if (branchId) match.branchId = toObjectId(branchId);
  if (method) match.method = method;
  if (status) match.status = status;

  const [docs, total] = await Promise.all([
    Payment.find(match)
      .populate('branchId', 'name')
      .populate({ path: 'saleId', select: 'receiptNumber cashierId', populate: { path: 'cashierId', select: 'name' } })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payment.countDocuments(match),
  ]);

  const items = docs.map((p) => ({
    id: p._id,
    saleId: p.saleId?._id || null,
    receiptNumber: p.saleId?.receiptNumber || null,
    createdAt: p.createdAt,
    branchName: p.branchId?.name || null,
    cashierName: p.saleId?.cashierId?.name || null,
    method: p.method,
    status: p.status,
    reference: p.reference || null,
    amount: fromCents(p.amount),
  }));

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * getExpensesDetail - individual expense entries for the Expenses-report
 * drill-downs. `description` falls back gracefully if the Expense model
 * doesn't have that exact field name in this codebase's schema.
 */
async function getExpensesDetail(businessId, { branchId, from, to, category, status, page = 1, limit = 20 }) {
  const match = { businessId: toObjectId(businessId), expenseDate: resolveDateRange(from, to) };
  if (branchId) match.branchId = toObjectId(branchId);
  if (category) match.category = category;
  if (status) match.status = status;

  const [docs, total] = await Promise.all([
    Expense.find(match)
      .populate('branchId', 'name')
      .sort({ expenseDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Expense.countDocuments(match),
  ]);

  const items = docs.map((e) => ({
    id: e._id,
    createdAt: e.expenseDate,
    branchName: e.branchId?.name || null,
    category: e.category,
    status: e.status,
    description: e.description || e.notes || null,
    amount: fromCents(e.amount),
  }));

  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getProfitReport(businessId, { branchId, from, to }) {
  const match = saleMatch({ businessId, branchId, from, to });

  const [agg] = await Sale.aggregate([
    { $match: match },
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        grossRevenue: { $sum: { $subtract: ['$items.total', '$items.taxAmount'] } },
        costOfGoodsSold: { $sum: { $multiply: ['$items.costPriceSnapshot', '$items.quantity'] } },
      },
    },
  ]);

  const expenseAgg = await Expense.aggregate([
    { $match: { businessId: toObjectId(businessId), ...(branchId ? { branchId: toObjectId(branchId) } : {}), status: 'APPROVED', expenseDate: resolveDateRange(from, to) } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const grossRevenue = agg?.grossRevenue || 0;
  const costOfGoodsSold = agg?.costOfGoodsSold || 0;
  const grossProfit = grossRevenue - costOfGoodsSold;
  const expenses = expenseAgg[0]?.total || 0;
  const netProfit = grossProfit - expenses;

  return {
    grossRevenue: fromCents(grossRevenue),
    costOfGoodsSold: fromCents(costOfGoodsSold),
    grossProfit: fromCents(grossProfit),
    expenses: fromCents(expenses),
    netProfit: fromCents(netProfit),
  };
}

async function getPaymentsReport(businessId, { branchId, from, to }) {
  const match = { businessId: toObjectId(businessId), createdAt: resolveDateRange(from, to) };
  if (branchId) match.branchId = toObjectId(branchId);

  const rows = await Payment.aggregate([
    { $match: match },
    { $group: { _id: { method: '$method', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  return rows.map((r) => ({ method: r._id.method, status: r._id.status, total: fromCents(r.total), count: r.count }));
}

async function getCashierReport(businessId, { branchId, from, to }) {
  const match = saleMatch({ businessId, branchId, from, to });

  const rows = await Sale.aggregate([
    { $match: match },
    { $group: { _id: '$cashierId', totalSales: { $sum: '$total' }, transactionCount: { $sum: 1 } } },
    { $sort: { totalSales: -1 } },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'cashier' } },
    { $unwind: '$cashier' },
  ]);

  return rows.map((r) => ({
    cashierId: r._id, name: r.cashier.name,
    totalSales: fromCents(r.totalSales), transactionCount: r.transactionCount,
    averageSale: fromCents(r.transactionCount ? Math.round(r.totalSales / r.transactionCount) : 0),
  }));
}

async function getExpenseReport(businessId, { branchId, from, to }) {
  const match = { businessId: toObjectId(businessId), expenseDate: resolveDateRange(from, to) };
  if (branchId) match.branchId = toObjectId(branchId);

  const rows = await Expense.aggregate([
    { $match: match },
    { $group: { _id: { category: '$category', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);

  return rows.map((r) => ({ category: r._id.category, status: r._id.status, total: fromCents(r.total), count: r.count }));
}

async function getCustomerReport(businessId) {
  const customers = await Customer.find({ businessId, outstandingBalance: { $gt: 0 } }).sort({ outstandingBalance: -1 }).limit(50);
  const totalOutstanding = customers.reduce((s, c) => s + c.outstandingBalance, 0);
  return {
    totalOutstanding: fromCents(totalOutstanding),
    customers: customers.map((c) => ({ customerId: c._id, name: c.name, phone: c.phone, outstandingBalance: fromCents(c.outstandingBalance), creditLimit: fromCents(c.creditLimit) })),
  };
}

async function getSupplierBalanceReport(businessId) {
  const suppliers = await Supplier.find({ businessId, currentBalance: { $gt: 0 } }).sort({ currentBalance: -1 }).limit(50);
  const totalPayable = suppliers.reduce((s, sup) => s + sup.currentBalance, 0);
  return {
    totalPayable: fromCents(totalPayable),
    suppliers: suppliers.map((s) => ({ supplierId: s._id, name: s.name, phone: s.phone, currentBalance: fromCents(s.currentBalance) })),
  };
}

async function getInventoryReport(businessId, { branchId }) {
  const match = { businessId };
  if (branchId) match.branchId = branchId;

  const rows = await BranchInventory.find(match).populate('productId', 'name sku costPrice');
  const valuation = rows.reduce((sum, r) => sum + r.quantity * (r.productId?.costPrice || 0), 0);
  const alerts = await getLowStockAlerts(businessId, branchId);

  return {
    totalSkus: rows.length,
    totalUnitsOnHand: rows.reduce((s, r) => s + r.quantity, 0),
    inventoryValuation: fromCents(valuation),
    lowStockCount: alerts.lowStockCount,
    outOfStockCount: alerts.outOfStockCount,
  };
}

async function getDashboard(businessId, { branchId, from, to }) {
  const range = from || to ? { from, to } : { from: new Date(new Date().setHours(0, 0, 0, 0)), to: new Date() };

  const [sales, profit, inventory, customerCredit, supplierBalances] = await Promise.all([
    getSalesReport(businessId, { branchId, ...range }),
    getProfitReport(businessId, { branchId, ...range }),
    getInventoryReport(businessId, { branchId }),
    getCustomerReport(businessId),
    getSupplierBalanceReport(businessId),
  ]);

  const cashierReport = await getCashierReport(businessId, { branchId, ...range });

  return {
    range,
    sales: {
      grossSales: sales.totalSales, netSales: sales.netSales, transactions: sales.transactionCount,
      totalDiscount: sales.totalDiscount, totalTax: sales.totalTax, totalRefunds: sales.totalRefunds,
      paymentBreakdown: sales.paymentBreakdown, topProducts: sales.topProducts.slice(0, 5),
    },
    profit,
    inventory: { lowStockCount: inventory.lowStockCount, outOfStockCount: inventory.outOfStockCount, inventoryValuation: inventory.inventoryValuation },
    outstandingCustomerCredit: customerCredit.totalOutstanding,
    supplierPayables: supplierBalances.totalPayable,
    topCashiers: cashierReport.slice(0, 5),
  };
}

async function getMyDashboard(businessId, userId, { branchId, from, to } = {}, { includeInventory = false } = {}) {
  const resolvedFrom = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const resolvedTo = to ? new Date(to) : new Date();
  // This is the line that used to break "My sales" for cashiers: userId
  // (req.user._id) flows straight into an aggregate() $match below via
  // saleMatch(), so it MUST be cast to ObjectId here - saleMatch now does
  // that internally, but resolvedFrom/resolvedTo/businessId/userId all
  // pass through it consistently as of this fix.
  const match = saleMatch({ businessId, branchId, cashierId: userId, from: resolvedFrom, to: resolvedTo });

  const [totals] = await Sale.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        netSales: { $sum: '$total' },
        transactionCount: { $sum: 1 },
        totalDiscount: { $sum: { $add: ['$itemDiscount', '$cartDiscount'] } },
      },
    },
  ]);

  // .find()/.distinct() cast automatically, so this line was never the
  // problem - it's why "recent sales" and thus the correct saleIds (used
  // below for the payment breakdown) always worked even while the totals
  // above read zero.
  const saleIds = await Sale.find(match).distinct('_id');
  const paymentBreakdownRaw = await Payment.aggregate([
    { $match: { businessId: toObjectId(businessId), saleId: { $in: saleIds }, status: 'SUCCESS' } },
    { $group: { _id: '$method', total: { $sum: '$amount' } } },
  ]);

  const topProductsRaw = await Sale.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', name: { $first: '$items.nameSnapshot' }, quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
    { $sort: { revenue: -1 } },
    { $limit: 5 },
  ]);

  const recentSalesRaw = await Sale.find(match)
    .sort({ soldAt: -1 })
    .limit(20)
    .select('receiptNumber total paymentStatus createdAt customerId branchId soldAt')
    .populate('customerId', 'name')
    .populate('branchId', 'name');

  const t = totals || { netSales: 0, transactionCount: 0, totalDiscount: 0 };

  const result = {
    range: { from: resolvedFrom, to: resolvedTo },
    sales: {
      netSales: fromCents(t.netSales),
      transactionCount: t.transactionCount,
      averageSale: fromCents(t.transactionCount ? Math.round(t.netSales / t.transactionCount) : 0),
      totalDiscount: fromCents(t.totalDiscount),
      paymentBreakdown: paymentBreakdownRaw.map((p) => ({ method: p._id, total: fromCents(p.total) })),
      topProducts: topProductsRaw.map((p) => ({ productId: p._id, name: p.name, quantity: p.quantity, revenue: fromCents(p.revenue) })),
    },
    recentSales: recentSalesRaw.map((s) => ({
      id: s._id,
      receiptNumber: s.receiptNumber,
      total: fromCents(s.total),
      paymentStatus: s.paymentStatus,
      createdAt: s.soldAt || s.createdAt,
      customerName: s.customerId?.name || null,
      branchName: s.branchId?.name || null,
    })),
  };

  if (includeInventory && branchId) {
    const alerts = await getLowStockAlerts(businessId, branchId);
    result.inventory = { lowStockCount: alerts.lowStockCount, outOfStockCount: alerts.outOfStockCount };
  }

  return result;
}

/**
 * Wholesale / retail PROFIT report - answers "what do I really earn from the warehouse?".
 *
 *  channels      RETAIL vs WHOLESALE: sales, revenue (ex-VAT), cost of goods, profit, margin, units (BASE units), money still owed.
 *  retailPremium For retail lines whose product has a wholesale price: the extra the owner earned by selling at the retail
 *                price instead of the lower wholesale price = retail revenue - (wholesale value of the same units).
 *                Also shows the profit those units would have made at wholesale, and the profit they actually made.
 *  transfers     Stock moved warehouse -> retail in the period: cost value, wholesale value, retail value at the new price,
 *                expected profit and uplift over wholesale (booked as real profit only when the goods are SOLD).
 *  byProduct     Per product and channel, with units in the base unit, so bundles and single units compare properly.
 *  trend         Profit per day per channel (business timezone).
 * Refunded quantities are taken out of revenue, cost and units, so the numbers match what was really kept.
 * Money in the response is KES (decimal); quantities are BASE units.
 */
async function getWholesaleReport(businessId, { branchId, from, to, warehouseId, top = 50 }) {
  const match = saleMatch({ businessId, branchId, from, to });
  if (warehouseId) match.warehouseId = toObjectId(warehouseId);
  const biz = await Business.findById(businessId).select('timezone').lean();
  const tz = biz?.timezone || 'Africa/Nairobi';

  const lineStages = [
    { $match: match },
    { $unwind: '$items' },
    { $addFields: { _q: { $subtract: ['$items.quantity', { $ifNull: ['$items.refundedQuantity', 0] }] } } },
    { $addFields: { _rf: { $cond: [{ $gt: ['$items.quantity', 0] }, { $divide: ['$_q', '$items.quantity'] }, 0] } } },
    { $project: {
      channel: { $ifNull: ['$channel', 'RETAIL'] },
      productId: '$items.productId', variantId: '$items.variantId', name: '$items.nameSnapshot', unitName: '$items.unitName',
      day: { $dateToString: { format: '%Y-%m-%d', date: '$soldAt', timezone: tz } },
      rev: { $multiply: [{ $subtract: ['$items.total', { $ifNull: ['$items.taxAmount', 0] }] }, '$_rf'] },
      cogs: { $multiply: ['$items.costPriceSnapshot', '$_q'] },
      baseQty: { $multiply: [{ $ifNull: ['$items.baseQuantity', '$items.quantity'] }, '$_rf'] },
      wsv: { $multiply: [{ $ifNull: ['$items.wholesaleValueSnapshot', 0] }, '$_q'] },
    } },
    { $addFields: {
      hasWs: { $cond: [{ $gt: ['$wsv', 0] }, 1, 0] },
      cmpRev: { $cond: [{ $gt: ['$wsv', 0] }, '$rev', 0] },
      cmpCogs: { $cond: [{ $gt: ['$wsv', 0] }, '$cogs', 0] },
    } },
  ];
  const sums = { rev: { $sum: '$rev' }, cogs: { $sum: '$cogs' }, baseQty: { $sum: '$baseQty' }, wsv: { $sum: '$wsv' }, cmpRev: { $sum: '$cmpRev' }, cmpCogs: { $sum: '$cmpCogs' } };

  const [byProductRaw, trendRaw, saleAgg] = await Promise.all([
    Sale.aggregate([...lineStages, { $group: { _id: { productId: '$productId', channel: '$channel' }, name: { $first: '$name' }, ...sums } }]),
    Sale.aggregate([...lineStages, { $group: { _id: { day: '$day', channel: '$channel' }, rev: sums.rev, cogs: sums.cogs } }, { $sort: { '_id.day': 1 } }]),
    Sale.aggregate([{ $match: match }, { $group: { _id: { $ifNull: ['$channel', 'RETAIL'] }, sales: { $sum: 1 }, invoiced: { $sum: '$total' }, outstanding: { $sum: '$balance' } } }]),
  ]);

  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 10000) / 100 : 0);
  const blank = () => ({ rev: 0, cogs: 0, baseQty: 0, wsv: 0, cmpRev: 0, cmpCogs: 0 });
  const add = (t, r) => { for (const k of Object.keys(t)) t[k] += r[k] || 0; };

  const ch = { RETAIL: { ...blank(), sales: 0, invoiced: 0, outstanding: 0 }, WHOLESALE: { ...blank(), sales: 0, invoiced: 0, outstanding: 0 } };
  const products = new Map();
  for (const r of byProductRaw) {
    const c = ch[r._id.channel] || (ch[r._id.channel] = { ...blank(), sales: 0, invoiced: 0, outstanding: 0 });
    add(c, r);
    const key = String(r._id.productId);
    if (!products.has(key)) products.set(key, { productId: r._id.productId, name: r.name, RETAIL: blank(), WHOLESALE: blank() });
    add((products.get(key)[r._id.channel] ||= blank()), r);
  }
  for (const r of saleAgg) { const c = ch[r._id] || (ch[r._id] = { ...blank(), sales: 0, invoiced: 0, outstanding: 0 }); c.sales = r.sales; c.invoiced = r.invoiced; c.outstanding = r.outstanding; }

  const channelOut = (c) => ({
    sales: c.sales, units: Math.round(c.baseQty * 1000) / 1000, revenue: fromCents(c.rev), costOfGoods: fromCents(c.cogs),
    profit: fromCents(c.rev - c.cogs), marginPercent: pct(c.rev - c.cogs, c.rev), invoiced: fromCents(c.invoiced), outstanding: fromCents(c.outstanding),
  });
  const channels = Object.fromEntries(Object.entries(ch).map(([k, v]) => [k, channelOut(v)]));
  const all = blank(); Object.values(ch).forEach((c) => add(all, c));
  const totals = { revenue: fromCents(all.rev), costOfGoods: fromCents(all.cogs), profit: fromCents(all.rev - all.cogs), marginPercent: pct(all.rev - all.cogs, all.rev) };

  // Retail lines that have a wholesale price: retail profit vs what the same units would have made at wholesale.
  const r = ch.RETAIL;
  const retailPremium = {
    comparableRevenue: fromCents(r.cmpRev), wholesaleValueOfSameUnits: fromCents(r.wsv),
    profitAtRetail: fromCents(r.cmpRev - r.cmpCogs), profitIfSoldAtWholesale: fromCents(r.wsv - r.cmpCogs),
    extraProfitFromRetailPrice: fromCents(r.cmpRev - r.wsv), upliftPercentOverWholesale: pct(r.cmpRev - r.wsv, r.wsv),
  };

  const byProduct = [...products.values()].map((p) => {
    const t = blank(); add(t, p.RETAIL); add(t, p.WHOLESALE);
    const row = (c) => ({ units: Math.round(c.baseQty * 1000) / 1000, revenue: fromCents(c.rev), profit: fromCents(c.rev - c.cogs) });
    return {
      productId: p.productId, name: p.name, units: Math.round(t.baseQty * 1000) / 1000, revenue: fromCents(t.rev), costOfGoods: fromCents(t.cogs),
      profit: fromCents(t.rev - t.cogs), marginPercent: pct(t.rev - t.cogs, t.rev), retail: row(p.RETAIL), wholesale: row(p.WHOLESALE),
      retailPremium: fromCents(p.RETAIL.cmpRev - p.RETAIL.wsv),
    };
  }).sort((a, b) => b.profit - a.profit).slice(0, top);

  const days = new Map();
  for (const t of trendRaw) {
    if (!days.has(t._id.day)) days.set(t._id.day, { date: t._id.day, retailProfit: 0, wholesaleProfit: 0, profit: 0 });
    const d = days.get(t._id.day); const p = fromCents(t.rev - t.cogs);
    if (t._id.channel === 'WHOLESALE') d.wholesaleProfit = Math.round((d.wholesaleProfit + p) * 100) / 100; else d.retailProfit = Math.round((d.retailProfit + p) * 100) / 100;
    d.profit = Math.round((d.retailProfit + d.wholesaleProfit) * 100) / 100;
  }

  // Warehouse -> retail moves in the period (the owner "sells to himself" at the new retail price).
  const tMatch = { businessId: toObjectId(businessId), kind: 'TO_RETAIL', createdAt: resolveDateRange(from, to) };
  if (branchId) tMatch.branchId = toObjectId(branchId);
  if (warehouseId) tMatch['from.warehouseId'] = toObjectId(warehouseId);
  const trRaw = await LocationTransfer.aggregate([
    { $match: tMatch }, { $unwind: '$items' },
    { $project: {
      productId: '$items.productId', name: '$items.nameSnapshot', baseUnit: '$items.baseUnitName', qty: '$items.quantity',
      cost: { $multiply: [{ $ifNull: ['$items.unitCostCents', 0] }, '$items.quantity'] },
      retail: { $multiply: [{ $ifNull: ['$items.retailPriceCents', 0] }, '$items.quantity'] },
      hasW: { $cond: [{ $eq: ['$items.priceFloorKind', 'WHOLESALE'] }, 1, 0] },
      wholesale: { $cond: [{ $eq: ['$items.priceFloorKind', 'WHOLESALE'] }, { $multiply: [{ $ifNull: ['$items.priceFloorCents', 0] }, '$items.quantity'] }, 0] },
      retailKnownW: { $cond: [{ $eq: ['$items.priceFloorKind', 'WHOLESALE'] }, { $multiply: [{ $ifNull: ['$items.retailPriceCents', 0] }, '$items.quantity'] }, 0] },
    } },
    { $group: { _id: '$productId', name: { $first: '$name' }, baseUnit: { $first: '$baseUnit' }, units: { $sum: '$qty' }, cost: { $sum: '$cost' }, retail: { $sum: '$retail' }, wholesale: { $sum: '$wholesale' }, retailKnownW: { $sum: '$retailKnownW' } } },
  ]);
  const tt = trRaw.reduce((a, x) => ({ units: a.units + x.units, cost: a.cost + x.cost, retail: a.retail + x.retail, wholesale: a.wholesale + x.wholesale, retailKnownW: a.retailKnownW + x.retailKnownW }), { units: 0, cost: 0, retail: 0, wholesale: 0, retailKnownW: 0 });
  const transfers = {
    totals: {
      units: Math.round(tt.units * 1000) / 1000, costValue: fromCents(tt.cost), wholesaleValue: fromCents(tt.wholesale), retailValue: fromCents(tt.retail),
      expectedProfit: fromCents(tt.retail - tt.cost), upliftOverWholesale: fromCents(tt.retailKnownW - tt.wholesale),
      note: 'Expected profit becomes real profit only when these goods are sold at the retail price.',
    },
    byProduct: trRaw.map((x) => ({
      productId: x._id, name: x.name, baseUnit: x.baseUnit, units: Math.round(x.units * 1000) / 1000, costValue: fromCents(x.cost), wholesaleValue: fromCents(x.wholesale),
      retailValue: fromCents(x.retail), expectedProfit: fromCents(x.retail - x.cost), upliftOverWholesale: fromCents(x.retailKnownW - x.wholesale),
    })).sort((a, b) => b.expectedProfit - a.expectedProfit),
  };

  return { range: { from: match.soldAt.$gte, to: match.soldAt.$lte }, totals, channels, retailPremium, transfers, byProduct, trend: [...days.values()] };
}

module.exports = {
  getWholesaleReport,
  getDashboard,
  getMyDashboard,
  getSalesReport,
  getSalesTrend,
  getSalesDetail,
  getPaymentsDetail,
  getExpensesDetail,
  getProfitReport,
  getPaymentsReport,
  getCashierReport,
  getExpenseReport,
  getCustomerReport,
  getSupplierBalanceReport,
  getInventoryReport,
};