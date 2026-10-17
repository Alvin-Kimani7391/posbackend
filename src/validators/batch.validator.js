const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const listBatchesQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  productId: objectId.optional(),
  status: z.enum(['active', 'quarantined', 'recalled', 'expired', 'depleted']).optional(),
  location: z.enum(['RETAIL', 'WAREHOUSE']).optional(),
});

const expiringQuery = z.object({
  branchId: objectId.optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  location: z.enum(['RETAIL', 'WAREHOUSE']).optional(),
});

const unbatchedQuery = z.object({
  branchId: objectId,
  location: z.enum(['RETAIL', 'WAREHOUSE']).optional(),
});
const backfillBody = z.object({
  branchId: objectId,
  productId: objectId,
  variantId: objectId.nullish(),
  batchNumber: z.string().trim().min(1, 'Enter a batch number'),
  expiryDate: z.coerce.date().optional(),
  manufacturingDate: z.coerce.date().optional(),
  quantity: z.coerce.number().positive(),
  location: z.enum(['RETAIL', 'WAREHOUSE']).optional(),
});

const availableQuery = z.object({
  branchId: objectId,
  productId: objectId,
  variantId: objectId.optional(),
});
const alertSettingsBody = z.object({
  criticalDays: z.coerce.number().int().min(1).max(365).optional(),
  warningDays: z.coerce.number().int().min(1).max(730).optional(),
  notifyEnabled: z.boolean().optional(),
});

const reasonBody = z.object({ reason: z.string().trim().min(3, 'Give a reason') });
const quarantineBody = reasonBody;
const releaseBody = reasonBody;
const disposeBody = reasonBody.extend({ type: z.enum(['EXPIRED', 'DAMAGE', 'LOST']).default('EXPIRED') });
const recallBody = z.object({
  batchNumber: z.string().trim().min(1),
  productId: objectId.optional(),
  branchId: objectId.optional(),
  reason: z.string().trim().min(3, 'Give a reason'),
});
const idParamSchema = z.object({ id: objectId });

module.exports = { availableQuery, alertSettingsBody, unbatchedQuery, backfillBody, listBatchesQuery, expiringQuery, quarantineBody, releaseBody, disposeBody, recallBody, idParamSchema };