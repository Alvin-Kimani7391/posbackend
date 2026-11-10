const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const { MOVEMENT_TYPES } = require('../models/InventoryMovement');

// z.coerce.boolean() turns the text "false" into true (any non-empty text is truthy), which made "?outOfStockOnly=false" filter the list.
const boolish = z.preprocess((v) => (typeof v === 'string' ? ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase()) : v), z.boolean()).optional();

const listInventoryQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  categoryId: objectId.optional(),
  lowStockOnly: boolish,
  outOfStockOnly: boolish,
});

const lowStockQuery = z.object({ branchId: objectId.optional() });

const movementsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  productId: objectId.optional(),
  variantId: objectId.optional(),
  categoryId: objectId.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  location: z.enum(['RETAIL', 'WAREHOUSE']).optional(),
  from: z.coerce.date().optional(), // start of the period (inclusive)
  to: z.coerce.date().optional(),   // end of the period (inclusive)
});

const adjustStockSchema = z.object({
  branchId: objectId,
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
  type: z.enum(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRED', 'LOST']),
  reason: z.string().trim().min(1),
  unitId: objectId.optional(), // quantity is in this unit (default: the base unit)
  location: z.enum(['RETAIL', 'WAREHOUSE']).default('RETAIL'),
});

const receiveStockSchema = z.object({
  branchId: objectId,
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
  costPrice: z.coerce.number().nonnegative().transform(toCents).optional(),
  batchNumber: z.string().trim().optional(),
  manufacturingDate: z.coerce.date().optional(),
  expiryDate: z.coerce.date().optional(),
  serials: z.array(z.string().trim().min(3).max(64)).max(1000).optional(),
  condition: z.enum(['new', 'used', 'refurbished']).optional(),
  reason: z.string().trim().optional(),
  unitId: objectId.optional(), // quantity / costPrice are per this unit (e.g. bundle); default: the base unit
  location: z.enum(['RETAIL', 'WAREHOUSE']).default('RETAIL'), // where the received goods go
  updateCost: z.preprocess((v) => (v === 'false' ? false : v === 'true' ? true : v), z.boolean()).default(true), // fold costPrice into the product's weighted-average cost
});

// ---- Unit conversion: price breakdown + break-down of stock into sellable sizes ----
const cents = z.coerce.number().nonnegative().transform(toCents);
const breakQty = z.object({ quantity: z.coerce.number().positive().max(10000000), unitId: objectId.optional() });
const breakDownSchema = z.object({
  branchId: objectId,
  productId: objectId,
  variantId: objectId.optional(),
  location: z.enum(['RETAIL', 'WAREHOUSE']).default('RETAIL'),
  source: breakQty, // what is being broken: 1 bag, or 25 (kg)
  outputs: z.array(z.object({ unitId: objectId.optional(), count: z.coerce.number().positive().max(1000000) })).max(30).default([]),
  wastage: breakQty.optional(),
  extraCost: cents.optional().default(0), // packaging, labels, labour for the whole break (KES)
  absorbWastage: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean()).default(false),
  note: z.string().trim().max(300).optional(),
});
const economicsQuery = z.object({ branchId: objectId.optional(), variantId: objectId.optional() });
const productIdParam = z.object({ productId: objectId });
const breaksQuery = paginationQuery.extend({ branchId: objectId.optional(), productId: objectId.optional() });

// ---- Transfers ----

const transferItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().int().positive(),
});

const createTransferSchema = z.object({
  fromBranchId: objectId,
  toBranchId: objectId,
  items: z.array(transferItemSchema).min(1),
  notes: z.string().trim().optional(),
});

const listTransfersQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  status: z.enum(['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
});

const idParamSchema = z.object({ id: objectId });

module.exports = {
  listInventoryQuery,
  lowStockQuery,
  movementsQuery,
  adjustStockSchema,
  receiveStockSchema,
  breakDownSchema,
  economicsQuery,
  productIdParam,
  breaksQuery,
  createTransferSchema,
  listTransfersQuery,
  idParamSchema,
};