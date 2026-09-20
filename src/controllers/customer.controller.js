const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const customerService = require('../services/customer.service');

exports.list = catchAsync(async (req, res) => {
  const result = await customerService.listCustomers(req.businessId, req.query);
  return sendSuccess(res, 200, 'Customers fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const customer = await customerService.getCustomer(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Customer fetched', { customer });
});

exports.create = catchAsync(async (req, res) => {
  const customer = await customerService.createCustomer(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Customer created', { customer });
});

exports.update = catchAsync(async (req, res) => {
  const customer = await customerService.updateCustomer(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Customer updated', { customer });
});

exports.setCreditLimit = catchAsync(async (req, res) => {
  const customer = await customerService.setCreditLimit(req.businessId, req.user._id, req.params.id, req.body.creditLimit);
  return sendSuccess(res, 200, 'Credit limit updated', { customer });
});

exports.getLedger = catchAsync(async (req, res) => {
  const result = await customerService.getLedger(req.businessId, req.params.id, req.query);
  return sendSuccess(res, 200, 'Ledger fetched', result);
});

exports.recordPayment = catchAsync(async (req, res) => {
  const result = await customerService.recordCustomerPayment(req.businessId, req.body.branchId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 201, 'Payment recorded', result);
});
