const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const { SHORTAGE_PAYMENT_METHODS } = require('../models/ShortagePayment');

const listShortagesQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  // UNSETTLED = OUTSTANDING + PARTIAL (anything still owing)
  status: z.enum(['OUTSTANDING', 'PARTIAL', 'CLEARED', 'UNSETTLED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const summaryQuery = z.object({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const shortagePaymentSchema = z.object({
  amount: z.coerce.number().positive().transform(toCents),
  method: z.enum(SHORTAGE_PAYMENT_METHODS).default('CASH'),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(500).optional(),
});

const idParamSchema = z.object({ id: objectId });

module.exports = { listShortagesQuery, summaryQuery, shortagePaymentSchema, idParamSchema };