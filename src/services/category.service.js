const Category = require('../models/Category');
const Product = require('../models/Product');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

async function listCategories(businessId, { search, parentCategoryId } = {}) {
  const filter = { businessId, status: 'active' };
  if (search) filter.name = new RegExp(search, 'i');
  if (parentCategoryId === 'root') filter.parentCategoryId = null;
  else if (parentCategoryId) filter.parentCategoryId = parentCategoryId;

  return Category.find(filter).sort({ name: 1 });
}

async function getCategory(businessId, id) {
  const category = await Category.findOne({ _id: id, businessId });
  if (!category) throw ApiError.notFound('Category not found');
  return category;
}

async function createCategory(businessId, userId, data) {
  if (data.parentCategoryId) {
    const parent = await Category.findOne({ _id: data.parentCategoryId, businessId });
    if (!parent) throw ApiError.badRequest('Parent category not found', 'INVALID_PARENT_CATEGORY');
  }

  const category = await Category.create({ ...data, businessId });
  await AuditLog.create({ businessId, userId, action: 'category.create', entityType: 'Category', entityId: category._id, newValue: category.toObject() });
  return category;
}

async function updateCategory(businessId, userId, id, updates) {
  const category = await Category.findOne({ _id: id, businessId });
  if (!category) throw ApiError.notFound('Category not found');

  if (updates.parentCategoryId) {
    if (updates.parentCategoryId === id) {
      throw ApiError.badRequest('A category cannot be its own parent', 'INVALID_PARENT_CATEGORY');
    }
    const parent = await Category.findOne({ _id: updates.parentCategoryId, businessId });
    if (!parent) throw ApiError.badRequest('Parent category not found', 'INVALID_PARENT_CATEGORY');
  }

  const oldValue = category.toObject();
  Object.assign(category, updates);
  await category.save();

  await AuditLog.create({ businessId, userId, action: 'category.update', entityType: 'Category', entityId: category._id, oldValue, newValue: category.toObject() });
  return category;
}

async function deleteCategory(businessId, userId, id) {
  const category = await Category.findOne({ _id: id, businessId });
  if (!category) throw ApiError.notFound('Category not found');

  const childCount = await Category.countDocuments({ businessId, parentCategoryId: id, status: 'active' });
  if (childCount > 0) throw ApiError.badRequest('Move or archive subcategories first', 'CATEGORY_HAS_CHILDREN');

  const productCount = await Product.countDocuments({ businessId, categoryId: id, status: 'active' });
  if (productCount > 0) throw ApiError.badRequest('Reassign products before archiving this category', 'CATEGORY_HAS_PRODUCTS');

  category.status = 'archived';
  await category.save();

  await AuditLog.create({ businessId, userId, action: 'category.archive', entityType: 'Category', entityId: category._id });
  return category;
}

module.exports = { listCategories, getCategory, createCategory, updateCategory, deleteCategory };
