const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const Refund = require('../models/Refund');
const Expense = require('../models/Expense');
const Customer = require('../models/Customer');
const Supplier = require('../models/Supplier');
const BranchInventory = require('../models/BranchInventory');
const { fromCents } = require('../utils/money');
const { getLowStockAlerts } = require('./inventory.service');

/** Resolves a {from, to} query into a concrete date range. Defaults to the last 30 days if neither is given. */
function resolveDateRange(from, to) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { $gte: start, $lte: end };
}

function saleMatch({ businessId, branchId, cashierId, from, to }) {
  const match = { businessId, saleStatus: 'COMPLETED', createdAt: resolveDateRange(from, to) };
  if (branchId) match.branchId = branchId;
  if (cashierId) match.cashierId = cashierId;
  return match;
}

/** Every money figure returned by the report functions below is converted with fromCents right before it leaves the service - the aggregation pipelines themselves stay in integer cents throughout, same as everywhere else in the app. */

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

  const saleIds = await Sale.find(match).distinct('_id');
  const paymentBreakdownRaw = await Payment.aggregate([
    { $match: { businessId, saleId: { $in: saleIds }, status: 'SUCCESS' } },
    { $group: { _id: '$method', total: { $sum: '$amount' } } },
  ]);

  const refundAgg = await Refund.aggregate([
    { $match: { businessId, saleId: { $in: saleIds }, status: 'COMPLETED' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);

  const topProductsRaw = await Sale.aggregate([
    { $match: match },
    { $unwind: '$items' },
    { $group: { _id: '$items.productId', name: { $first: '$items.nameSnapshot' }, quantity: { $sum: '$items.quantity' }, revenue: { $sum: '$items.total' } } },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
  ]);

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
  };
}

/**
 * getProfitReport - gross profit is derived STRICTLY from each sale item's
 * stored snapshots (unitPrice/costPriceSnapshot/taxAmount at the moment it
 * was sold), never from today's Product.costPrice. See spec section 40.
 */
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
    { $match: { businessId, ...(branchId ? { branchId } : {}), status: 'APPROVED', expenseDate: resolveDateRange(from, to) } },
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
  const match = { businessId, createdAt: resolveDateRange(from, to) };
  if (branchId) match.branchId = branchId;

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
  const match = { businessId, expenseDate: resolveDateRange(from, to) };
  if (branchId) match.branchId = branchId;

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

/**
 * getDashboard - the single "how's the business doing" view. Defaults to
 * TODAY unless a date range is given.
 */
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

/**
 * getMyDashboard - a personal, self-scoped view for a single employee
 * (typically a CASHIER, who has no reports.view). cashierId is ALWAYS
 * userId - it is never read from the query string, so there is no way for
 * a caller to request another employee's figures through this function.
 * Contains no cost/profit data (that stays behind reports.profit).
 */
async function getMyDashboard(businessId, userId, { branchId, from, to } = {}, { includeInventory = false } = {}) {
  const range = from || to ? { from, to } : { from: new Date(new Date().setHours(0, 0, 0, 0)), to: new Date() };
  const match = saleMatch({ businessId, branchId, cashierId: userId, from: range.from, to: range.to });

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

  const saleIds = await Sale.find(match).distinct('_id');
  const paymentBreakdownRaw = await Payment.aggregate([
    { $match: { businessId, saleId: { $in: saleIds }, status: 'SUCCESS' } },
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
    .limit(8)
    .select('receiptNumber total paymentStatus createdAt customerId')
    .populate('customerId', 'name');

  const t = totals || { netSales: 0, transactionCount: 0, totalDiscount: 0 };

  const result = {
    range,
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
  getProfitReport,
  getPaymentsReport,
  getCashierReport,
  getExpenseReport,
  getCustomerReport,
  getSupplierBalanceReport,
  getInventoryReport,
};