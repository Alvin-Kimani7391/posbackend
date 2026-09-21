const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const reportService = require('../services/report.service');

exports.dashboard = catchAsync(async (req, res) => {
  const result = await reportService.getDashboard(req.businessId, req.query);
  return sendSuccess(res, 200, 'Dashboard fetched', result);
});

exports.sales = catchAsync(async (req, res) => {
  const result = await reportService.getSalesReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Sales report fetched', result);
});

exports.profit = catchAsync(async (req, res) => {
  const result = await reportService.getProfitReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Profit report fetched', result);
});

exports.inventory = catchAsync(async (req, res) => {
  const result = await reportService.getInventoryReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Inventory report fetched', result);
});

exports.payments = catchAsync(async (req, res) => {
  const result = await reportService.getPaymentsReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Payments report fetched', { breakdown: result });
});

exports.cashiers = catchAsync(async (req, res) => {
  const result = await reportService.getCashierReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Cashier report fetched', { cashiers: result });
});

exports.expenses = catchAsync(async (req, res) => {
  const result = await reportService.getExpenseReport(req.businessId, req.query);
  return sendSuccess(res, 200, 'Expense report fetched', { breakdown: result });
});

exports.customers = catchAsync(async (req, res) => {
  const result = await reportService.getCustomerReport(req.businessId);
  return sendSuccess(res, 200, 'Customer report fetched', result);
});

exports.suppliers = catchAsync(async (req, res) => {
  const result = await reportService.getSupplierBalanceReport(req.businessId);
  return sendSuccess(res, 200, 'Supplier balance report fetched', result);
});