const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const saleService = require('../services/sale.service');
const receiptService = require('../services/receipt.service');
const { hasPermission } = require('../utils/permissionCheck');
const { ROLES } = require('../constants/roles');

exports.create = catchAsync(async (req, res) => {
  const result = await saleService.createSale(req.businessId, req.body.branchId, req.user, req.body);
  return sendSuccess(res, 201, result.replayed ? 'Sale already recorded' : 'Sale completed', result);
});

/**
 * list - SELF-SCOPING for non-elevated users.
 *
 * Any role with sales.view can hit this route (that includes CASHIER by
 * default), but the query previously let ANY caller pass any cashierId or
 * branchId and see someone else's sales. That's now locked down:
 *   - a user with reports.view (Owner/Admin/Manager/Accountant) can query
 *     freely, exactly as before.
 *   - anyone else can only ever see their OWN sales (cashierId is forced to
 *     req.user._id) within a branch they're actually assigned to (branchId
 *     is forced/validated against req.user.branchIds).
 * This is what makes the "view my sales" drill-down on the personal
 * dashboard safe to build against this same endpoint.
 */
exports.list = catchAsync(async (req, res) => {
  const query = { ...req.query };
  const isElevated = req.user.role === ROLES.OWNER || req.user.role === ROLES.ADMIN || hasPermission(req.user, 'reports.view');

  if (!isElevated) {
    query.cashierId = String(req.user._id);
    if (query.branchId) {
      const allowed = (req.user.branchIds || []).map(String);
      if (!allowed.includes(String(query.branchId))) delete query.branchId;
    }
  }

  const result = await saleService.listSales(req.businessId, query);
  return sendSuccess(res, 200, 'Sales fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const result = await saleService.getSale(req.businessId, req.params.id);
  const isElevated = req.user.role === ROLES.OWNER || req.user.role === ROLES.ADMIN || hasPermission(req.user, 'reports.view');
  if (!isElevated && String(result.sale.cashierId?._id || result.sale.cashierId) !== String(req.user._id)) {
    return sendSuccess(res, 200, 'Sale fetched', { sale: null }); // hide, don't 403-leak existence details
  }
  return sendSuccess(res, 200, 'Sale fetched', result);
});

exports.cancel = catchAsync(async (req, res) => {
  const sale = await saleService.cancelSale(req.businessId, req.user._id, req.params.id, req.body.reason);
  return sendSuccess(res, 200, 'Sale cancelled', { sale });
});

exports.getReceipt = catchAsync(async (req, res) => {
  const receipt = await receiptService.getReceiptBySale(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Receipt fetched', { receipt });
});

exports.printReceipt = catchAsync(async (req, res) => {
  const receipt = await receiptService.recordPrint(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Print recorded', { receipt });
});