const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const LOCATION = z.enum(['RETAIL', 'WAREHOUSE']);
const moneyInput = z.coerce.number().nonnegative().transform(toCents);

const locationTransferItem = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),  // in `unitId` (default: the product's base unit)
  unitId: objectId.optional(),             // UNIT CONVERSION: move "2 bundles" -> 48 packets
  // warehouse -> retail: the NEW retail selling price per BASE unit (must be higher than the wholesale price).
  // Omit to keep the current retail price (allowed only if it is already higher than the wholesale price).
  retailPrice: moneyInput.optional(),
  batchId: objectId.optional(),
  serialNumbers: z.array(z.string().trim().min(3).max(64)).max(1000).optional(),
});

const locationTransferSchema = z.object({
  branchId: objectId.optional(),           // shop-floor branch (default: the warehouse's branch)
  fromLocation: LOCATION,
  toLocation: LOCATION,
  fromWarehouseId: objectId.optional(),    // default: the branch's default warehouse
  toWarehouseId: objectId.optional(),
  items: z.array(locationTransferItem).min(1).max(200),
  notes: z.string().trim().max(500).optional(),
}).refine((v) => !(v.fromLocation === 'RETAIL' && v.toLocation === 'RETAIL'), { message: 'Choose at least one warehouse', path: ['toLocation'] })
  .refine((v) => v.fromLocation !== 'WAREHOUSE' || v.toLocation !== 'WAREHOUSE' || !v.fromWarehouseId || !v.toWarehouseId || v.fromWarehouseId !== v.toWarehouseId, { message: 'Source and destination warehouse are the same', path: ['toWarehouseId'] })
  .refine((v) => v.fromLocation !== 'WAREHOUSE' || v.toLocation !== 'WAREHOUSE' || (v.fromWarehouseId && v.toWarehouseId), { message: 'Give fromWarehouseId and toWarehouseId for a warehouse-to-warehouse move', path: ['toWarehouseId'] });

const createWarehouseSchema = z.object({
  branchId: objectId,
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(20).optional(),
  address: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(500).optional(),
  managerId: objectId.optional(),
  allowSales: z.coerce.boolean().optional(),
});

const updateWarehouseSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  address: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  notes: z.string().trim().max(500).optional(),
  managerId: objectId.optional(),
  allowSales: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const adjustWarehouseSchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().refine((n) => n !== 0, 'Quantity cannot be zero'), // + adds, - removes; in unitId
  unitId: objectId.optional(),
  type: z.enum(['OPENING_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGE', 'EXPIRED', 'LOST']).optional(),
  reason: z.string().trim().min(1).max(300),
});

const wholesaleSettingsSchema = z.object({
  defaultMode: z.enum(['RETAIL', 'WHOLESALE']).optional(),
  defaultWarehouseId: objectId.optional(),
  requireCustomerForWholesale: z.boolean().optional(),
  defaultPaymentTermsDays: z.coerce.number().int().min(0).max(365).optional(),
  allowRetailFromWarehouse: z.boolean().optional(),
  showUnitSwitcher: z.boolean().optional(),
});

const warehouseListQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  warehouseId: objectId.optional(),
  lowStockOnly: z.coerce.boolean().optional(),
  outOfStockOnly: z.coerce.boolean().optional(),
});
const warehousesQuery = z.object({ branchId: objectId.optional(), status: z.enum(['active', 'inactive']).optional() });
const overviewQuery = paginationQuery.extend({ branchId: objectId.optional(), warehouseId: objectId.optional() });
const catalogQuery = paginationQuery.extend({ branchId: objectId.optional(), warehouseId: objectId.optional(), inStockOnly: z.enum(['true', 'false']).optional().transform((v) => v !== 'false') });
const listLocationTransfersQuery = paginationQuery.extend({
  branchId: objectId.optional(), warehouseId: objectId.optional(), productId: objectId.optional(),
  fromLocation: LOCATION.optional(), kind: z.enum(['TO_RETAIL', 'TO_WAREHOUSE', 'WAREHOUSE_TO_WAREHOUSE']).optional(),
});
const idParamSchema = z.object({ id: objectId });

module.exports = {
  locationTransferSchema, createWarehouseSchema, updateWarehouseSchema, adjustWarehouseSchema, wholesaleSettingsSchema,
  warehouseListQuery, warehousesQuery, overviewQuery, catalogQuery, listLocationTransfersQuery, idParamSchema, LOCATION,
};
