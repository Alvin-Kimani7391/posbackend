const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/supplier-finance.service');

exports.recordInvoice = catchAsync(async (req, res) => sendSuccess(res, 200, 'Supplier invoice recorded', { purchase: await svc.recordSupplierInvoice(req.businessId, req.user._id, req.params.id, req.body) }));
exports.approveVariance = catchAsync(async (req, res) => sendSuccess(res, 200, 'Variance approved', { purchase: await svc.approveInvoiceVariance(req.businessId, req.user._id, req.params.id, req.body) }));
exports.pay = catchAsync(async (req, res) => sendSuccess(res, 201, 'Supplier payment recorded', { payment: await svc.recordSupplierPayment(req.businessId, req.user._id, req.body) }));
exports.voidPayment = catchAsync(async (req, res) => sendSuccess(res, 200, 'Payment voided', { payment: await svc.voidSupplierPayment(req.businessId, req.user._id, req.params.id, req.body.reason) }));
exports.listPayments = catchAsync(async (req, res) => sendSuccess(res, 200, 'Supplier payments fetched', await svc.listSupplierPayments(req.businessId, req.query)));
exports.statement = catchAsync(async (req, res) => sendSuccess(res, 200, 'Supplier statement fetched', await svc.supplierStatement(req.businessId, req.params.supplierId, req.query)));
exports.ageing = catchAsync(async (req, res) => sendSuccess(res, 200, 'Payables ageing fetched', await svc.payablesAgeing(req.businessId, req.query)));
