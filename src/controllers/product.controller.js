const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const productService = require('../services/product.service');

exports.list = catchAsync(async (req, res) => {
  const result = await productService.listProducts(req.businessId, req.query);
  return sendSuccess(res, 200, 'Products fetched', result);
});

exports.getOne = catchAsync(async (req, res) => {
  const product = await productService.getProduct(req.businessId, req.params.id);
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
