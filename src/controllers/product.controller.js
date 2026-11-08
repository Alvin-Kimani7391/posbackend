const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const productService = require('../services/product.service');

exports.list = catchAsync(async (req, res) => {
  const result = await productService.listProducts(req.businessId, req.query);
  return sendSuccess(res, 200, 'Products fetched', result);
});

/**
 * GET /products/catalog - the WHOLE active product list in ONE request (same item shape as GET /products).
 * The till keeps it on the device so search and barcode scans are instant, instead of downloading 30 pages one by one.
 * Catalogs bigger than the cap are not served here (the till then keeps using the paged list + server search).
 */
const CATALOG_CAP = 5000;
exports.catalog = catchAsync(async (req, res) => {
  const mongoose = require('mongoose');
  const { branchId, channel, status } = req.query;
  const result = await productService.listProducts(req.businessId, {
    page: 1,
    limit: CATALOG_CAP,
    status: status === 'archived' ? 'archived' : 'active',
    channel: channel === 'retail' ? 'retail' : undefined,
    branchId: branchId && mongoose.isValidObjectId(branchId) ? branchId : undefined,
  });
  return sendSuccess(res, 200, 'Products fetched', result);
});

exports.stockLevels = catchAsync(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
  const stock = await productService.stockLevels(req.businessId, ids, req.query.branchId || undefined);
  return sendSuccess(res, 200, 'Stock fetched', { stock });
});

exports.getOne = catchAsync(async (req, res) => {
  const product = await productService.getProduct(req.businessId, req.params.id, { branchId: req.query.branchId || undefined });
  return sendSuccess(res, 200, 'Product fetched', { product });
});

exports.create = catchAsync(async (req, res) => {
  const product = await productService.createProduct(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Product created', { product });
});

exports.update = catchAsync(async (req, res) => {
  const product = await productService.updateProduct(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Product updated', { product });
});

exports.remove = catchAsync(async (req, res) => {
  const product = await productService.archiveProduct(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Product archived', { product });
});

exports.restore = catchAsync(async (req, res) => {
  const product = await productService.restoreProduct(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Product restored', { product });
});

exports.lookupByBarcode = catchAsync(async (req, res) => {
  const result = await productService.lookupByBarcode(req.businessId, req.params.barcode);
  return sendSuccess(res, 200, 'Product found', result);
});

exports.lookupBySku = catchAsync(async (req, res) => {
  const result = await productService.lookupBySku(req.businessId, req.params.sku);
  return sendSuccess(res, 200, 'Product found', result);
});

exports.addVariant = catchAsync(async (req, res) => {
  const variant = await productService.addVariant(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 201, 'Variant added', { variant });
});

exports.updateVariant = catchAsync(async (req, res) => {
  const variant = await productService.updateVariant(req.businessId, req.user._id, req.params.id, req.params.variantId, req.body);
  return sendSuccess(res, 200, 'Variant updated', { variant });
});

exports.removeVariant = catchAsync(async (req, res) => {
  const variant = await productService.archiveVariant(req.businessId, req.user._id, req.params.id, req.params.variantId);
  return sendSuccess(res, 200, 'Variant archived', { variant });
});