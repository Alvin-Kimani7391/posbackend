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

const createProductSchema = z.object({
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

const updateProductSchema = createProductSchema.partial().omit({ variants: true });

const listProductsQuery = paginationQuery.extend({
  categoryId: objectId.optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const idParamSchema = z.object({ id: objectId });
const variantParamSchema = z.object({ id: objectId, variantId: objectId });
const barcodeParamSchema = z.object({ barcode: z.string().trim().min(1) });
const skuParamSchema = z.object({ sku: z.string().trim().min(1) });

const addVariantSchema = variantInput;
const updateVariantSchema = variantInput.partial();

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