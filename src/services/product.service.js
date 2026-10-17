const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Category = require('../models/Category');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { wholesaleConfigIssues, wholesaleFirstIssues } = require('../utils/wholesale');
const { unitConfigIssues } = require('../utils/units');

/** Units (bundle, carton...) need the unitConversions feature and a sane set-up (unique names, factor > 0). */
async function assertUnitsAllowed(businessId, units, baseUnit) {
  if (!units || !units.length) return;
  const business = await Business.findById(businessId).select('featureSettings').lean();
  if (!business?.featureSettings?.unitConversions) {
    throw ApiError.forbidden('Unit conversion is not enabled for your business. Turn on "Unit conversions" in business settings first.', 'FEATURE_DISABLED');
  }
  const issues = unitConfigIssues(units, baseUnit);
  if (issues.length) throw ApiError.badRequest(issues[0].message, 'INVALID_UNITS', issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
}

/** Escapes user text so it is matched literally inside a RegExp (e.g. "TV (43") never throws). */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function assertCategoryBelongsToBusiness(businessId, categoryId) {
  if (!categoryId) return;
  const category = await Category.findOne({ _id: categoryId, businessId });
  if (!category) throw ApiError.badRequest('Category not found', 'INVALID_CATEGORY');
}

/** Wholesale can only be switched on when the business has the `wholesalePricing` feature. */
async function assertWholesaleFeatureOn(businessId) {
  const business = await Business.findById(businessId).select('featureSettings').lean();
  if (!business?.featureSettings?.wholesalePricing) {
    throw ApiError.forbidden('Wholesale pricing is not enabled for your business. Turn on "Wholesale pricing" in business settings first.', 'FEATURE_DISABLED');
  }
}

function assertWholesaleConfig(issues) {
  if (!issues.length) return;
  throw ApiError.badRequest(issues[0].message, 'INVALID_WHOLESALE_CONFIG', issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
}

/** Plain (raw cents) copy of unit sub-documents, safe to feed to the validators. */
const plainUnits = (units) => (units || []).map((u) => ({
  name: u.name, factor: u.factor, wholesalePrice: u.wholesalePrice, retailPrice: u.retailPrice,
  isWholesaleDefault: !!u.isWholesaleDefault, status: u.status,
}));

/** WHOLESALE_FIRST set-up (wholesale price is the main price, retail optional). Throws a 400 with field errors. */
function assertWholesaleFirst({ retailEnabled, wholesalePrice, sellingPrice, units }) {
  const issues = wholesaleFirstIssues({ retailEnabled: retailEnabled !== false, wholesalePrice, sellingPrice, units: plainUnits(units) });
  if (issues.length) throw ApiError.badRequest(issues[0].message, 'INVALID_WHOLESALE_CONFIG', issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
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

async function listProducts(businessId, { page, limit, search, categoryId, status, channel }) {
  const filter = { businessId };
  if (channel === 'retail') filter.retailEnabled = { $ne: false }; // hides wholesale-only products from retail selling
  if (status) filter.status = status;
  else filter.status = { $ne: 'archived' };
  if (categoryId) filter.categoryId = categoryId;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: rx }, { sku: rx }, { barcode: rx }, { brand: rx }];
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
  await assertUnitsAllowed(businessId, data.units, data.unit);

  const { variants: rawVariants, ...rawProductData } = data;
  // null (= "not set") is only meaningful on UPDATE; on create just omit it.
  const productData = { ...rawProductData };
  if (productData.wholesalePrice == null) delete productData.wholesalePrice;
  if (productData.moq == null) delete productData.moq;
  const variants = rawVariants && rawVariants.map((v) => {
    const { wholesalePrice, ...rest } = v;
    return wholesalePrice == null ? rest : { ...rest, wholesalePrice };
  });

  if (productData.pricingMode === 'WHOLESALE_FIRST') {
    // Wholesale is the default price; the MOQ-discount mechanism (wholesaleEnabled) is not used in this mode.
    productData.wholesaleEnabled = false;
    delete productData.moq;
    productData.retailEnabled = productData.retailEnabled !== false;
    if (productData.sellingPrice === undefined) {
      // Wholesale-only product: no retail price exists, keep a harmless placeholder (wholesale value per base unit).
      const wu = (productData.units || []).find((u) => u.isWholesaleDefault && u.status !== 'inactive');
      productData.sellingPrice = Math.round((wu ? wu.wholesalePrice / wu.factor : productData.wholesalePrice) || 0);
    }
    assertWholesaleFirst({ retailEnabled: productData.retailEnabled, wholesalePrice: productData.wholesalePrice, sellingPrice: productData.sellingPrice, units: productData.units });
  } else {
    productData.retailEnabled = true;
    if (productData.wholesaleEnabled) await assertWholesaleFeatureOn(businessId);
  }

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
    newValue: {
      name: product.name,
      sku: product.sku,
      defaultDiscount: product.defaultDiscount,
      wholesaleEnabled: product.wholesaleEnabled,
      moq: product.moq,
      wholesalePrice: product.wholesalePrice,
      pricingMode: product.pricingMode,
      retailEnabled: product.retailEnabled,
      variantCount: createdVariants.length,
    },
  });

  const obj = product.toObject();
  obj.variants = createdVariants;
  return obj;
}

async function updateProduct(businessId, userId, id, updates) {
  const product = await Product.findOne({ _id: id, businessId });
  if (!product) throw ApiError.notFound('Product not found');

  await assertCategoryBelongsToBusiness(businessId, updates.categoryId);
  await assertUnitsAllowed(businessId, updates.units, updates.unit || product.unit);

  const wasWholesale = !!product.wholesaleEnabled;
  const oldValue = {
    sellingPrice: product.sellingPrice,
    costPrice: product.costPrice,
    defaultDiscount: product.defaultDiscount,
    wholesaleEnabled: product.wholesaleEnabled,
    moq: product.moq,
    wholesalePrice: product.wholesalePrice,
    retailEnabled: product.retailEnabled,
    status: product.status,
  };

  // Never write `undefined` into the document: Mongoose treats it as "remove
  // this field", which would silently wipe saved values (e.g. the discount).
  const cleaned = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
  Object.assign(product, cleaned);
  product.updatedBy = userId;

  // Wholesale-first products: the MOQ-discount mechanism is off, and the merged set-up is re-checked when a
  // price / unit / retail switch is touched. A retail-first product is always retail-enabled.
  const wholesaleFirst = product.pricingMode === 'WHOLESALE_FIRST';
  if (wholesaleFirst) {
    product.wholesaleEnabled = false;
    if (['pricingMode', 'retailEnabled', 'wholesalePrice', 'sellingPrice', 'units'].some((k) => k in cleaned)) {
      assertWholesaleFirst({ retailEnabled: product.retailEnabled, wholesalePrice: product.wholesalePrice, sellingPrice: product.sellingPrice, units: product.units });
    }
  } else {
    product.retailEnabled = true;
  }

  // The per-unit discount may never exceed the unit price. Checked on the
  // MERGED values so lowering the price below an existing discount is caught
  // too. (Variant products have per-variant prices; those are clamped to the
  // line total at sale time instead.)
  if (!product.hasVariants && (product.defaultDiscount || 0) > (product.sellingPrice || 0)) {
    throw ApiError.badRequest('Discount cannot be more than the selling price', 'INVALID_DISCOUNT');
  }

  // Wholesale: turning it ON needs the business feature; the set-up is re-checked on MERGED values, but only when this
  // request touches a wholesale-related field (so a rename is never blocked by an older price change).
  if (!wholesaleFirst && product.wholesaleEnabled && !wasWholesale) await assertWholesaleFeatureOn(businessId);
  if (!wholesaleFirst && product.wholesaleEnabled && ['wholesaleEnabled', 'moq', 'wholesalePrice', 'sellingPrice'].some((k) => k in cleaned)) {
    const activeVariants = product.hasVariants
      ? await ProductVariant.find({ businessId, productId: product._id, status: 'active' }).lean()
      : [];
    assertWholesaleConfig(wholesaleConfigIssues({
      wholesaleEnabled: true, moq: product.moq, wholesalePrice: product.wholesalePrice,
      sellingPrice: product.sellingPrice, hasVariants: product.hasVariants, variants: activeVariants,
    }));
  }

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
    newValue: {
      sellingPrice: product.sellingPrice,
      costPrice: product.costPrice,
      defaultDiscount: product.defaultDiscount,
      wholesaleEnabled: product.wholesaleEnabled,
      moq: product.moq,
      wholesalePrice: product.wholesalePrice,
      retailEnabled: product.retailEnabled,
      status: product.status,
    },
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

  const { wholesalePrice, ...restOfData } = data;
  const variantData = wholesalePrice == null ? restOfData : { ...restOfData, wholesalePrice };

  if (product.wholesaleEnabled) {
    const existing = await ProductVariant.find({ businessId, productId, status: 'active' }).lean();
    assertWholesaleConfig(wholesaleConfigIssues({
      wholesaleEnabled: true, moq: product.moq, wholesalePrice: product.wholesalePrice,
      sellingPrice: product.sellingPrice, hasVariants: true, variants: [...existing, variantData],
    }));
  }

  let variant;
  try {
    variant = await ProductVariant.create({ ...variantData, businessId, productId });
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

  const oldValue = { sellingPrice: variant.sellingPrice, costPrice: variant.costPrice, wholesalePrice: variant.wholesalePrice, status: variant.status };
  const cleaned = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
  Object.assign(variant, cleaned); // wholesalePrice: null clears the variant's own price (falls back to the product's)

  if ('wholesalePrice' in cleaned || 'sellingPrice' in cleaned) {
    const parent = await Product.findOne({ _id: productId, businessId });
    if (parent?.wholesaleEnabled) {
      const others = await ProductVariant.find({ businessId, productId, status: 'active', _id: { $ne: variant._id } }).lean();
      assertWholesaleConfig(wholesaleConfigIssues({
        wholesaleEnabled: true, moq: parent.moq, wholesalePrice: parent.wholesalePrice, sellingPrice: parent.sellingPrice,
        hasVariants: true, variants: [...others, { sku: variant.sku, sellingPrice: variant.sellingPrice, wholesalePrice: variant.wholesalePrice }],
      }));
    }
  }

  try {
    await variant.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A variant with this SKU or barcode already exists', 'DUPLICATE_VARIANT');
    throw err;
  }

  await AuditLog.create({ businessId, userId, action: 'product.variant.update', entityType: 'ProductVariant', entityId: variant._id, oldValue, newValue: { sellingPrice: variant.sellingPrice, costPrice: variant.costPrice, wholesalePrice: variant.wholesalePrice, status: variant.status } });
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
 * (The returned product carries defaultDiscount, which the POS auto-applies.)
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