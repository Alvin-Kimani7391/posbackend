const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const Product = require('../models/Product');
const { wholesaleConfigIssues } = require('../utils/wholesale');

// Decimal KES from the client (e.g. 1250.50) -> integer cents for storage.
// See utils/money.js for the full rationale.
const moneyInput = z.coerce.number().nonnegative('Must be zero or greater').transform(toCents);

// Wholesale inputs: '', null and 0 mean "not set" -> null (so an emptied field never becomes a free price).
// Absent stays undefined (partial update leaves the saved value alone); null on update clears it.
const optionalWholesalePrice = z
  .preprocess((v) => (v === '' ? null : v), z.coerce.number().nonnegative('Must be zero or greater'))
  .transform((n) => { const c = toCents(n); return c > 0 ? c : null; })
  .optional();
const optionalMoq = z
  .preprocess((v) => (v === '' ? null : v), z.coerce.number().nonnegative('Must be zero or greater').max(1000000, 'MOQ is too large'))
  .transform((n) => (n > 0 ? n : null))
  .optional();
// z.coerce.boolean() reads the string "false" as true; wholesaleEnabled must not flip silently.
const strictBoolean = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const attributesInput = z.record(z.string()).optional();

// Other units of the product (bundle = 24 packets...). factor = base units per 1 of this unit; prices are for ONE unit.
const unitInput = z.object({
  _id: z.string().optional(), // keep the id when editing so old sales/purchases still point at the same unit
  name: z.string().trim().min(1).max(30),
  code: z.string().trim().max(12).optional(),
  factor: z.coerce.number().positive(),
  barcode: z.string().trim().optional(),
  wholesalePrice: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number().nonnegative().transform(toCents).optional()),
  retailPrice: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.number().nonnegative().transform(toCents).optional()),
  isWholesaleDefault: z.coerce.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const variantInput = z.object({
  sku: z.string().trim().min(1),
  barcode: z.string().trim().optional(),
  attributes: attributesInput,
  costPrice: moneyInput.optional().default(0),
  sellingPrice: moneyInput,
  wholesalePrice: optionalWholesalePrice, // falls back to the product's wholesalePrice when empty
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
});

// Plain object shape, shared by create (adds a cross-field check below) and
// update (partial). Kept separate because .partial() is not available once a
// schema has been wrapped in superRefine().
const productBase = z.object({
  categoryId: objectId.optional(),
  name: z.string().trim().min(1),
  sku: z.string().trim().min(1),
  barcode: z.string().trim().optional(),
  description: z.string().trim().optional(),
  brand: z.string().trim().optional(),
  productType: z.enum(Product.PRODUCT_TYPES).optional(),
  // WHOLESALE_FIRST = wholesale price is the main price and retail is optional (wholesalers). Default RETAIL_FIRST.
  pricingMode: z.enum(Product.PRICING_MODES).optional(),
  retailEnabled: strictBoolean.optional(),
  costPrice: moneyInput.optional().default(0),
  // Required, except for WHOLESALE_FIRST products where the service derives it (see createProduct).
  sellingPrice: moneyInput.optional(),
  // Sold at wholesalePrice (per unit) once a sale holds at least `moq` of this product. See utils/wholesale.js.
  wholesaleEnabled: strictBoolean.optional(),
  moq: optionalMoq,
  wholesalePrice: optionalWholesalePrice,
  // Standing per-unit discount, auto-applied at the till. 0 = none.
  defaultDiscount: moneyInput.optional().default(0),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  taxCategory: z.string().trim().optional(),
  unit: z.enum(Product.UNITS).optional(), // BASE unit
  units: z.array(unitInput).max(10).optional(),
  trackInventory: z.coerce.boolean().optional(),
  trackSerialNumber: z.coerce.boolean().optional(),
  serialKind: z.enum(['serial', 'imei']).optional(),
  warrantyMonths: z.coerce.number().int().min(0).max(120).optional(),
  supplierWarrantyMonths: z.coerce.number().int().min(0).max(120).optional(),
  trackBatch: z.coerce.boolean().optional(),
  trackExpiry: z.coerce.boolean().optional(),
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
  image: z.string().trim().optional(),
  variants: z.array(variantInput).optional(),
});

// Values here are already integer cents (the transforms above have run).
const createProductSchema = productBase.superRefine((data, ctx) => {
  if (data.sellingPrice === undefined && data.pricingMode !== 'WHOLESALE_FIRST') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sellingPrice'], message: 'Required' });
  }
  const hasVariants = Array.isArray(data.variants) && data.variants.length > 0;
  if (!hasVariants && data.sellingPrice !== undefined && data.defaultDiscount > data.sellingPrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultDiscount'],
      message: 'Discount cannot be more than the selling price',
    });
  }

  for (const issue of wholesaleConfigIssues({
    wholesaleEnabled: data.wholesaleEnabled, moq: data.moq, wholesalePrice: data.wholesalePrice,
    sellingPrice: data.sellingPrice, hasVariants, variants: data.variants || [],
  })) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
  }
});

// Partial: an omitted field must stay undefined so editing other fields never
// silently resets a saved discount or cost price. costPrice and
// defaultDiscount are re-declared WITHOUT .default(0) so this holds on every
// Zod version (newer versions can apply defaults inside optional fields).
// The "discount <= price" rule for updates is enforced in product.service.js
// against the merged (existing + changed) values.
const updateProductSchema = productBase
  .partial()
  .extend({
    costPrice: moneyInput.optional(),
    defaultDiscount: moneyInput.optional(),
  })
  .omit({ variants: true });

const listProductsQuery = paginationQuery.extend({
  categoryId: objectId.optional(),
  status: z.enum(['active', 'archived']).optional(),
  channel: z.enum(['retail']).optional(), // retail = hide wholesale-only products (retail till / shop-floor sales)
});

const idParamSchema = z.object({ id: objectId });
const variantParamSchema = z.object({ id: objectId, variantId: objectId });
const barcodeParamSchema = z.object({ barcode: z.string().trim().min(1) });
const skuParamSchema = z.object({ sku: z.string().trim().min(1) });

const addVariantSchema = variantInput;
// costPrice re-declared without .default(0) so editing a variant's price never resets its cost.
const updateVariantSchema = variantInput.partial().extend({ costPrice: moneyInput.optional() });

module.exports = {
  createProductSchema,
  updateProductSchema,
  listProductsQuery,
  idParamSchema,
  variantParamSchema,
  barcodeParamSchema,
  skuParamSchema,
  addVariantSchema,
  updateVariantSchema,
};