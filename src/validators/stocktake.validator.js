const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const createStocktakeSchema = z.object({
  branchId: objectId,
  name: z.string().trim().max(120).optional(),
  blind: z.boolean().optional().default(true),
  scope: z.object({
    type: z.enum(['ALL', 'CATEGORY', 'PRODUCTS']).default('ALL'),
    categoryIds: z.array(objectId).optional(),
    productIds: z.array(objectId).optional(),
  }).superRefine((s, ctx) => {
    if (s.type === 'CATEGORY' && !s.categoryIds?.length) ctx.addIssue({ code: 'custom', message: 'categoryIds required', path: ['categoryIds'] });
    if (s.type === 'PRODUCTS' && !s.productIds?.length) ctx.addIssue({ code: 'custom', message: 'productIds required', path: ['productIds'] });
  }).optional().default({ type: 'ALL' }),
});

const recordCountsSchema = z.object({
  counts: z.array(z.object({
    lineId: objectId,
    countedQty: z.coerce.number().min(0),
    note: z.string().trim().max(300).optional(),
  })).min(1).max(500),
});

const submitSchema = z.object({ skipUncounted: z.boolean().optional().default(false) }).default({});
const approveSchema = z.object({
  rejectLineIds: z.array(objectId).optional().default([]),
  note: z.string().trim().max(500).optional(),
}).default({});
const cancelSchema = z.object({ reason: z.string().trim().min(3, 'Give a reason') });

const listQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  status: z.enum(['OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED']).optional(),
});
const idParamSchema = z.object({ id: objectId });

module.exports = { createStocktakeSchema, recordCountsSchema, submitSchema, approveSchema, cancelSchema, listQuery, idParamSchema };