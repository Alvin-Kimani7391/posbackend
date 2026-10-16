const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const reportService = require('../services/report.service');
const { hasPermission } = require('../utils/permissionCheck');
const { ROLES } = require('../constants/roles');

// Every report is in the business's single currency; say which, so the app never guesses KES.
const tag = (req, data) => ({ ...data, currency: req.currency || 'KES', countryCode: req.countryCode || 'KE' });

exports.dashboard = catchAsync(async (req, res) => {
  const result = await reportService.getDashboard(req.businessId, req.query);
  return sendSuccess(res, 200, 'Dashboard fetched', tag(req, result));
});

exports.myDashboard = catchAsync(async (req, res) => {
  let { branchId } = req.query;
  const isElevated = req.user.role === ROLES.OWNER || req.user.role === ROLES.ADMIN;
  if (branchId && !isElevated) {
    const allowed = (req.user.branchIds || []).map(String);
    if (!allowed.includes(String(branchId))) branchId = undefined;
  }

  const includeInventory = hasPermission(req.user, 'inventory.view');
  const result = await reportService.getMyDashboard(
    req.businessId,
    req.user._id,
    { ...req.query, branchId },
    { includeInventory }
  );
  return sendSuccess(res, 200, 'My dashboard fetched', tag(req, result));
});

exports.sales = catchAsync(async (req, res) => {
  const result = await reportService.getSalesReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Sales report fetched', tag(req, result));
});

/** salesDetail - the individual sales behind a Sales-report KPI. Gated by
 * reports.view (same as every other route in this router except /me), so
 * this is admin/manager territory - the self-scoped equivalent for an
 * ordinary cashier remains GET /sales (see sale.controller.js). */
exports.salesDetail = catchAsync(async (req, res) => {
  const result = await reportService.getSalesDetail(req.businessId, req.query);
  return sendSuccess(res, 200, 'Sales detail fetched', tag(req, result));
});

exports.paymentsDetail = catchAsync(async (req, res) => {
  const result = await reportService.getPaymentsDetail(req.businessId, req.query);
  return sendSuccess(res, 200, 'Payments detail fetched', tag(req, result));
});

exports.expensesDetail = catchAsync(async (req, res) => {
  const result = await reportService.getExpensesDetail(req.businessId, req.query);
  return sendSuccess(res, 200, 'Expenses detail fetched', tag(req, result));
});

exports.profit = catchAsync(async (req, res) => {
  const result = await reportService.getProfitReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Profit report fetched', tag(req, result));
});

exports.inventory = catchAsync(async (req, res) => {
  const result = await reportService.getInventoryReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Inventory report fetched', tag(req, result));
});

exports.payments = catchAsync(async (req, res) => {
  const result = await reportService.getPaymentsReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Payments report fetched', tag(req, { breakdown: result }));
});

exports.cashiers = catchAsync(async (req, res) => {
  const result = await reportService.getCashierReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Cashier report fetched', tag(req, { cashiers: result }));
});

exports.expenses = catchAsync(async (req, res) => {
  const result = await reportService.getExpenseReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Expense report fetched', tag(req, { breakdown: result }));
});

exports.customers = catchAsync(async (req, res) => {
  const result = await reportService.getCustomerReport(req.businessId);
  return sendSuccess(res, 200, 'Customer report fetched', tag(req, result));
});

exports.suppliers = catchAsync(async (req, res) => {
  const result = await reportService.getSupplierBalanceReport(req.businessId);
  return sendSuccess(res, 200, 'Supplier balance report fetched', tag(req, result));
});
exports.wholesale = catchAsync(async (req, res) => {
  const result = await reportService.getWholesaleReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Wholesale profit report fetched', tag(req, result));
});
