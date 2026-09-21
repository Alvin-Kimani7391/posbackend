const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const expenseService = require('../services/expense.service');

exports.list = catchAsync(async (req, res) => {
  const result = await expenseService.listExpenses(req.businessId, req.query);
  return sendSuccess(res, 200, 'Expenses fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const expense = await expenseService.getExpense(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Expense fetched', { expense });
});

exports.create = catchAsync(async (req, res) => {
  const expense = await expenseService.createExpense(req.businessId, req.body.branchId, req.user, req.body);
  return sendSuccess(res, 201, 'Expense recorded', { expense });
});

exports.approve = catchAsync(async (req, res) => {
  const expense = await expenseService.setExpenseStatus(req.businessId, req.user._id, req.params.id, 'APPROVED');
  return sendSuccess(res, 200, 'Expense approved', { expense });
});

exports.reject = catchAsync(async (req, res) => {
  const expense = await expenseService.setExpenseStatus(req.businessId, req.user._id, req.params.id, 'REJECTED', req.body.rejectionReason);
  return sendSuccess(res, 200, 'Expense rejected', { expense });
});
