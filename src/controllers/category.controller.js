const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const categoryService = require('../services/category.service');

exports.list = catchAsync(async (req, res) => {
  const categories = await categoryService.listCategories(req.businessId, req.query);
  return sendSuccess(res, 200, 'Categories fetched', { categories });
});

exports.getOne = catchAsync(async (req, res) => {
  const category = await categoryService.getCategory(req.businessId, req.params.id);
  return sendSuccess(res, 200, 'Category fetched', { category });
});

exports.create = catchAsync(async (req, res) => {
  const category = await categoryService.createCategory(req.businessId, req.user._id, req.body);
  return sendSuccess(res, 201, 'Category created', { category });
});

exports.update = catchAsync(async (req, res) => {
  const category = await categoryService.updateCategory(req.businessId, req.user._id, req.params.id, req.body);
  return sendSuccess(res, 200, 'Category updated', { category });
});

exports.remove = catchAsync(async (req, res) => {
  const category = await categoryService.deleteCategory(req.businessId, req.user._id, req.params.id);
  return sendSuccess(res, 200, 'Category archived', { category });
});
