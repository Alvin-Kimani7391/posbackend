const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Category = require('../models/Category');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

async function assertCategoryBelongsToBusiness(businessId, categoryId) {
  if (!categoryId) return;
  const category = await Category.findOne({ _id: categoryId, businessId });
  if (!category) throw ApiError.badRequest('Category not found', 'INVALID_CATEGORY');
}

async function attachVariants(businessId, products) {
  const productIds = products.map((p) => p._id);
  const variants = await ProductVariant.find({ businessId, productId: { $in: productIds }, status: 'active' });
  const byProduct = variants.reduce((acc, v) => {
    (acc[v.productId.toString()] ||= []).push(v);
    return acc;
  }, {});
  return products.map((p) => {
    const obj = p.toObject();
    obj.variants = byProduct[p._id.toString()] || [];
    return obj;
  });
}

async function listProducts(businessId, { page, limit, search, categoryId, status }) {
  const filter = { businessId };
  if (status) filter.status = status;
  else filter.status = { $ne: 'archived' };
  if (categoryId) filter.categoryId = categoryId;
  if (search) {
    filter.$or = [
      { name: new RegExp(search, 'i') },
      { sku: new RegExp(search, 'i') },
      { barcode: new RegExp(search, 'i') },
      { brand: new RegExp(search, 'i') },
    ];
  }

  const [items, total] = await Promise.all([
    Product.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('categoryId', 'name'),
    Product.countDocuments(filter),
  ]);

  const withVariants = await attachVariants(businessId, items);
  return { items: withVariants, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getProduct(businessId, id) {
  const product = await Product.findOne({ _id: id, businessId }).populate('categoryId', 'name');
  if (!product) throw ApiError.notFound('Product not found');
  const [withVariants] = await attachVariants(businessId, [product]);
  return withVariants;
}

async function createProduct(businessId, userId, data) {
  await assertCategoryBelongsToBusiness(businessId, data.categoryId);

  const { variants, ...productData } = data;

  let product;
  try {
    product = await Product.create({
      ...productData,
      businessId,
      hasVariants: !!(variants && variants.length),
      createdBy: userId,
    });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {}).find((k) => k !== 'businessId') || 'sku/barcode';
      throw ApiError.conflict(`A product with this ${field} already exists`, 'DUPLICATE_PRODUCT');
    }
    throw err;
  }

  let createdVariants = [];
  if (variants && variants.length) {
    try {
      createdVariants = await ProductVariant.insertMany(
        variants.map((v) => ({ ...v, businessId, productId: product._id })),
        { ordered: true }
      );
    } catch (err) {
      // Roll back the just-created product so we don't leave an orphaned
      // "has variants" product with zero actual variants.
      await Product.deleteOne({ _id: product._id });
      if (err.code === 11000) {
        throw ApiError.conflict('A variant with this SKU or barcode already exists', 'DUPLICATE_VARIANT');
      }
      throw err;
    }
  }

  await AuditLog.create({
    businessId,
    userId,
    action: 'product.create',
    entityType: 'Product',
    entityId: product._id,
    newValue: { name: product.name, sku: product.sku, variantCount: createdVariants.length },
  });

  const obj = product.toObject();
  obj.variants = createdVariants;
  return obj;
}

async function updateProduct(businessId, userId, id, updates) {
  const product = await Product.findOne({ _id: id, businessId });
  if (!product) throw ApiError.notFound('Product not found');

  await assertCategoryBelongsToBusiness(businessId, updates.categoryId);

  const oldValue = { sellingPrice: product.sellingPrice, costPrice: product.costPrice, status: product.status };

  Object.assign(product, updates);
  product.updatedBy = userId;

  try {
    await product.save();
  } catch (err) {
    if (err.code === 11000) {
      throw ApiError.conflict('A product with this SKU or barcode already exists', 'DUPLICATE_PRODUCT');
    }
    throw err;
  }

  await AuditLog.create({
    businessId,
    userId,
    action: 'product.update',
    entityType: 'Product',
    entityId: product._id,
    oldValue,
    newValue: { sellingPrice: product.sellingPrice, costPrice: product.costPrice, status: product.status },
  });

  return getProduct(businessId, id);
}

async function archiveProduct(businessId, userId, id) {
  const product = await Product.findOne({ _id: id, businessId });
  if (!product) throw ApiError.notFound('Product not found');

  product.status = 'archived';
  await product.save();
  await ProductVariant.updateMany({ businessId, productId: id }, { status: 'archived' });

  await AuditLog.create({ businessId, userId, action: 'product.archive', entityType: 'Product', entityId: product._id });
  return product;
}

/* ----------------------------- Variants ----------------------------- */

async function addVariant(businessId, userId, productId, data) {
  const product = await Product.findOne({ _id: productId, businessId });
  if (!product) throw ApiError.notFound('Product not found');

  let variant;
  try {
    variant = await ProductVariant.create({ ...data, businessId, productId });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A variant with this SKU or barcode already exists', 'DUPLICATE_VARIANT');
    throw err;
  }

  if (!product.hasVariants) {
    product.hasVariants = true;
    await product.save();
  }

  await AuditLog.create({ businessId, userId, action: 'product.variant.create', entityType: 'ProductVariant', entityId: variant._id, newValue: variant.toObject() });
  return variant;
}

async function updateVariant(businessId, userId, productId, variantId, updates) {
  const variant = await ProductVariant.findOne({ _id: variantId, businessId, productId });
  if (!variant) throw ApiError.notFound('Variant not found');

  const oldValue = { sellingPrice: variant.sellingPrice, costPrice: variant.costPrice, status: variant.status };
  Object.assign(variant, updates);

  try {
    await variant.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A variant with this SKU or barcode already exists', 'DUPLICATE_VARIANT');
    throw err;
  }

  await AuditLog.create({ businessId, userId, action: 'product.variant.update', entityType: 'ProductVariant', entityId: variant._id, oldValue, newValue: { sellingPrice: variant.sellingPrice, costPrice: variant.costPrice, status: variant.status } });
  return variant;
}

async function archiveVariant(businessId, userId, productId, variantId) {
  const variant = await ProductVariant.findOne({ _id: variantId, businessId, productId });
  if (!variant) throw ApiError.notFound('Variant not found');

  variant.status = 'archived';
  await variant.save();

  await AuditLog.create({ businessId, userId, action: 'product.variant.archive', entityType: 'ProductVariant', entityId: variant._id });
  return variant;
}

/* --------------------------- POS lookups ----------------------------- */

/**
 * Unified barcode lookup used by the POS scanner - checks products first,
 * then variants, and returns a normalized shape either way so the frontend
 * doesn't need to special-case which one it got.
 */
async function lookupByBarcode(businessId, barcode) {
  const product = await Product.findOne({ businessId, barcode, status: 'active' }).populate('categoryId', 'name');
  if (product) return { type: 'product', product, variant: null };

  const variant = await ProductVariant.findOne({ businessId, barcode, status: 'active' });
  if (variant) {
    const parent = await Product.findOne({ _id: variant.productId, businessId, status: 'active' });
    if (!parent) throw ApiError.notFound('Product not found for this barcode');
    return { type: 'variant', product: parent, variant };
  }

  throw ApiError.notFound('No product found for this barcode', 'BARCODE_NOT_FOUND');
}

async function lookupBySku(businessId, sku) {
  const product = await Product.findOne({ businessId, sku: sku.toUpperCase(), status: 'active' }).populate('categoryId', 'name');
  if (product) return { type: 'product', product, variant: null };

  const variant = await ProductVariant.findOne({ businessId, sku: sku.toUpperCase(), status: 'active' });
  if (variant) {
    const parent = await Product.findOne({ _id: variant.productId, businessId, status: 'active' });
    if (!parent) throw ApiError.notFound('Product not found for this SKU');
    return { type: 'variant', product: parent, variant };
  }

  throw ApiError.notFound('No product found for this SKU', 'SKU_NOT_FOUND');
}

module.exports = {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  archiveProduct,
  addVariant,
  updateVariant,
  archiveVariant,
  lookupByBarcode,
  lookupBySku,
};
