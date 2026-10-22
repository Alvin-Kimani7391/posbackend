const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');
const K = require('../constants/cashier');

const branchQ = z.object({ branchId: objectId.optional() });
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const queueQuery = z.object({
  branchId: objectId.optional(),
  channel: z.enum(Object.keys(K.CHANNELS)).optional(),
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(300).optional(),
});

const paymentsQuery = z.object({
  branchId: objectId.optional(),
  date: ymd.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'CREDIT', 'DEPOSIT', 'ROOM', 'OTHER']).optional(),
  kind: z.enum(['PAYMENT', 'REFUND', 'DEPOSIT']).optional(),
  channel: z.enum(Object.keys(K.CHANNELS)).optional(),
  search: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(600).optional(),
});

const idParam = z.object({ id: objectId });

// Amounts arrive as decimal KES and are converted to integer cents here, like every other money input.
const drawerEventBody = z.object({
  type: z.enum(K.DRAWER_EVENT_TYPES),
  amount: z.coerce.number().positive().max(10000000).transform(toCents).optional(),
  reason: z.string().trim().min(3, 'Give a reason').max(300).optional(),
  reference: z.string().trim().max(80).optional(),
  billId: objectId.optional(),
}).strict();

module.exports = { branchQ, queueQuery, paymentsQuery, idParam, drawerEventBody };
