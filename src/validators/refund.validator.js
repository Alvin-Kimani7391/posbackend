const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const refundItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
});

const createRefundSchema = z.object({
  branchId: objectId,
  saleId: objectId,
  items: z.array(refundItemSchema).min(1),
  reason: z.string().trim().min(1),
  paymentMethod: z.enum(['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER']),
});

const listRefundsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  saleId: objectId.optional(),
  status: z.enum(['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED']).optional(),
});

const rejectRefundSchema = z.object({ rejectionReason: z.string().trim().min(1) });
const idParamSchema = z.object({ id: objectId });

module.exports = { createRefundSchema, listRefundsQuery, rejectRefundSchema, idParamSchema };
