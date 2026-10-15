const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const LOCATION = z.enum(['RETAIL', 'WAREHOUSE']);

const locationTransferItem = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
  batchId: objectId.optional(),                                                  // optional: pick one source batch (else FEFO)
  serialNumbers: z.array(z.string().trim().min(3).max(64)).max(1000).optional(), // required for serial-tracked products
});

const locationTransferSchema = z.object({
  branchId: objectId,
  fromLocation: LOCATION,
  toLocation: LOCATION,
  items: z.array(locationTransferItem).min(1).max(200),
  notes: z.string().trim().max(500).optional(),
}).refine((v) => v.fromLocation !== v.toLocation, { message: 'Source and destination must be different', path: ['toLocation'] });

const warehouseListQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  lowStockOnly: z.coerce.boolean().optional(),
  outOfStockOnly: z.coerce.boolean().optional(),
});

const overviewQuery = paginationQuery.extend({ branchId: objectId.optional() });

const listLocationTransfersQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  fromLocation: LOCATION.optional(),
  productId: objectId.optional(),
});

const idParamSchema = z.object({ id: objectId });

module.exports = { locationTransferSchema, warehouseListQuery, overviewQuery, listLocationTransfersQuery, idParamSchema, LOCATION };
