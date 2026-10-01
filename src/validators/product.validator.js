const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const Product = require('../models/Product');

// Decimal KES from the client (e.g. 1250.50) -> integer cents for storage.
// See utils/money.js for the full rationale.
const moneyInput = z.coerce.number().nonnegative('Must be zero or greater').transform(toCents);

const attributesInput = z.record(z.string()).optional();

const variantInput = z.object({
  sku: z.string().trim().min(1),
  barcode: z.string().trim().optional(),
  attributes: attributesInput,
  costPrice: moneyInput.optional().default(0),
  sellingPrice: moneyInput,
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
  costPrice: moneyInput.optional().default(0),
  sellingPrice: moneyInput,
  wholesalePrice: moneyInput.optional(),
  // Standing per-unit discount, auto-applied at the till. 0 = none.
  defaultDiscount: moneyInput.optional().default(0),
  taxRate: z.coerce.number().min(0).max(100).optional(),
  taxCategory: z.string().trim().optional(),
  unit: z.enum(Product.UNITS).optional(),
  trackInventory: z.coerce.boolean().optional(),
  trackSerialNumber: z.coerce.boolean().optional(),
  trackBatch: z.coerce.boolean().optional(),
  trackExpiry: z.coerce.boolean().optional(),
  lowStockThreshold: z.coerce.number().int().min(0).optional(),
  image: z.string().trim().optional(),
  variants: z.array(variantInput).optional(),
});

// Values here are already integer cents (the transforms above have run).
const createProductSchema = productBase.superRefine((data, ctx) => {
  const hasVariants = Array.isArray(data.variants) && data.variants.length > 0;
  if (!hasVariants && data.sellingPrice !== undefined && data.defaultDiscount > data.sellingPrice) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['defaultDiscount'],
      message: 'Discount cannot be more than the selling price',
    });
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