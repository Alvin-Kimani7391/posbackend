const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

// ---------------------------------------------------------------------------
// Everything money-related in the sync payload is INTEGER CENTS with a "Cents"
// suffix. The device converts catalog prices to cents once and never uses floats.
// ---------------------------------------------------------------------------
const deviceIdStr = z.string().trim().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid device id');
const cents = z.number().int().min(0).max(100000000000);
const positiveCents = z.number().int().min(1).max(100000000000);
const MPESA_CODE = /^[A-Z][A-Z0-9]{9}$/;

const offlineItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  name: z.string().trim().max(120).optional(), // what the receipt showed the customer
  quantity: z.number().positive().max(1000000),
  unitPriceCents: cents,
  discountCents: cents.default(0),
  taxRate: z.number().min(0).max(100),
  taxAmountCents: cents,
  totalCents: cents,
  batchId: objectId.optional(),
  serialNumbers: z.array(z.string().trim().max(64)).max(1000).optional(),
  // UNIT CONVERSION: quantity / unitPriceCents are per `unitId` (e.g. bundle). unitName/unitFactor are the till's snapshot.
  unitId: objectId.optional(),
  unitName: z.string().trim().max(40).optional(),
  unitFactor: z.number().positive().max(1000000).optional(),
});

const mpesaClaimSchema = z.object({
  code: z.string().trim().transform((v) => v.toUpperCase()).refine((v) => MPESA_CODE.test(v), 'Invalid M-PESA code'),
  payerPhone: z.string().trim().min(9).max(16),
  payerName: z.string().trim().max(80).optional(),
});

const offlinePaymentSchema = z
  .object({
    method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']),
    amountCents: positiveCents,
    amountTenderedCents: cents.optional(),
    reference: z.string().trim().max(60).optional(),
    mpesa: mpesaClaimSchema.optional(),
  })
  .refine((p) => p.method !== 'MPESA' || !!p.mpesa, { message: 'M-PESA payments need the M-PESA code and the payer phone', path: ['mpesa'] });

const offlineSaleSchema = z.object({
  clientTransactionId: z.string().trim().min(8).max(64),
  type: z.literal('SALE').optional(),
  outboxSeq: z.number().int().min(1).max(1000000000), // device-wide order of ALL events (sales + shifts)
  localSeq: z.number().int().min(1).max(100000000),   // receipt sequence (sales only)
  clientShiftId: z.string().trim().min(8).max(64).optional(),
  soldAt: z.coerce.date(),
  grant: z.string().min(20).max(4000),
  shiftId: objectId.optional(),
  customerId: objectId.optional(),
  items: z.array(offlineItemSchema).min(1).max(200),
  payments: z.array(offlinePaymentSchema).max(6),
  // WHOLESALE sale made offline: sold from a warehouse's stock at wholesale unit prices.
  channel: z.enum(['RETAIL', 'WHOLESALE']).default('RETAIL'),
  warehouseId: objectId.optional(),
  dueDate: z.coerce.date().optional(),
  cartDiscountCents: cents.default(0),
  subtotalCents: cents,
  itemDiscountCents: cents,
  taxCents: cents,
  totalCents: cents,
  catalogVersion: z.string().trim().max(64).optional(),
  notes: z.string().trim().max(300).optional(),
});

const denominationLine = z.object({ denomination: z.number().positive().max(100000), count: z.number().int().min(0).max(1000000) });
const eventBase = {
  clientEventId: z.string().trim().min(8).max(64),
  outboxSeq: z.number().int().min(1).max(1000000000),
  occurredAt: z.coerce.date(),
  grant: z.string().min(20).max(4000),
};
const shiftOpenSchema = z.object({
  type: z.literal('SHIFT_OPEN'), ...eventBase,
  clientShiftId: z.string().trim().min(8).max(64),
  registerId: objectId,
  openingCashCents: cents,
});
const shiftCloseSchema = z
  .object({
    type: z.literal('SHIFT_CLOSE'), ...eventBase,
    clientShiftId: z.string().trim().min(8).max(64).optional(),
    shiftId: objectId.optional(),
    denominations: z.array(denominationLine).max(30),
    notes: z.string().trim().max(300).optional(),
  })
  .refine((e) => !!e.clientShiftId || !!e.shiftId, { message: 'Say which shift to close', path: ['shiftId'] });

// Each event is validated INDIVIDUALLY in the service so one malformed sale never blocks the batch.
const pushSchema = z.object({
  deviceId: deviceIdStr,
  deviceTime: z.coerce.date(),
  pendingCount: z.number().int().min(0).optional(),
  appVersion: z.string().trim().max(40).optional(),
  items: z.array(z.unknown()).min(1).max(25), // sales and shift events, each with a `type` (default SALE)
});

const deviceQuery = z.object({ deviceId: deviceIdStr });
const catalogQuery = deviceQuery.extend({
  type: z.enum(['products', 'variants', 'categories', 'stock', 'batches', 'serials', 'customers', 'warehouses', 'warehouseStock']),
  cursor: z.string().trim().max(80).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// ---- review screens ----
const reviewListQuery = paginationQuery.extend({
  status: z.string().trim().max(30).optional(),
  branchId: objectId.optional(),
});
const idParamSchema = z.object({ id: objectId });
const rejectClaimSchema = z.object({ note: z.string().trim().min(3).max(300), chargeCashier: z.boolean().optional() });
const optionalNoteSchema = z.object({ note: z.string().trim().max(300).optional() });
const requiredNoteSchema = z.object({ note: z.string().trim().min(3).max(300) });
const gapsQuery = z.object({ deviceId: deviceIdStr });

module.exports = {
  offlineSaleSchema, shiftOpenSchema, shiftCloseSchema, rejectClaimSchema, pushSchema, deviceQuery, catalogQuery,
  reviewListQuery, idParamSchema, optionalNoteSchema, requiredNoteSchema, gapsQuery,
};