const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { PAYMENT_METHODS, PAYMENT_STATUSES } = require('../models/Payment');

const listPaymentsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  saleId: objectId.optional(),
  customerId: objectId.optional(),
  shiftId: objectId.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const idParamSchema = z.object({ id: objectId });

module.exports = { listPaymentsQuery, idParamSchema };
