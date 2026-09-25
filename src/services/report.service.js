const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const Expense = require('../models/Expense');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const Business = require('../models/Business');
const BranchInventory = require('../models/BranchInventory');
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
  const match = { businessId: toObjectId(businessId), saleStatus: 'COMPLETED', createdAt: resolveDateRange(from, to) };
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
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } },
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
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Sale.countDocuments(match),
  ]);

  const items = docs.map((s) => ({
    id: s._id,
    receiptNumber: s.receiptNumber,
    createdAt: s.createdAt,
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
    .sort({ createdAt: -1 })
    .limit(20)
    .select('receiptNumber total paymentStatus createdAt customerId branchId')
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
      createdAt: s.createdAt,
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

module.exports = {
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