const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const REASONS = ['DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'QUALITY', 'OVERSUPPLY', 'PRICE_DISPUTE', 'RECALL', 'OTHER'];

const createPurchaseReturnSchema = z.object({
  reason: z.enum(REASONS),
  reasonNote: z.string().trim().max(500).optional(),
  returnDate: z.coerce.date().optional(),
  creditNoteNumber: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    itemIndex: z.coerce.number().int().min(0),
    quantity: z.coerce.number().positive(),                   // in the purchase unit of that line
    serialNumbers: z.array(z.string().trim().min(1).max(64)).max(1000).optional(), // required for serial-tracked products
  })).min(1).max(200),
});


const listPurchaseReturnsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  supplierId: objectId.optional(),
  purchaseId: objectId.optional(),
  reason: z.enum(REASONS).optional(),
  refundStatus: z.enum(['NONE', 'PENDING', 'PARTIAL', 'SETTLED', 'CREDIT_HELD']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const recordRefundSchema = z.object({
  amount: z.coerce.number().positive().transform(toCents),
  method: z.enum(['CASH', 'MPESA', 'BANK', 'CHEQUE', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional(),
});

const holdCreditSchema = z.object({ note: z.string().trim().max(300).optional() }).default({});

const idParamSchema = z.object({ id: objectId });

module.exports = { createPurchaseReturnSchema, listPurchaseReturnsQuery, recordRefundSchema, holdCreditSchema, idParamSchema, REASONS };