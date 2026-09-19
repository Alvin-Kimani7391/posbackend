const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const { MOVEMENT_TYPES } = require('../models/InventoryMovement');

const listInventoryQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  lowStockOnly: z.coerce.boolean().optional(),
  outOfStockOnly: z.coerce.boolean().optional(),
});

const lowStockQuery = z.object({ branchId: objectId.optional() });

const movementsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  productId: objectId.optional(),
  variantId: objectId.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
});

const adjustStockSchema = z.object({
  branchId: objectId,
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
  type: z.enum(['ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRED', 'LOST']),
  reason: z.string().trim().min(1),
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
  reason: z.string().trim().optional(),
});

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
  createTransferSchema,
  listTransfersQuery,
  idParamSchema,
};
