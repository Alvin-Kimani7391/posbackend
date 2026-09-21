const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const moneyInput = z.coerce.number().nonnegative().transform(toCents);

const purchaseItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
  unitCost: moneyInput,
  taxRate: z.coerce.number().min(0).max(100).optional().default(0),
  discount: moneyInput.optional().default(0),
});

const createPurchaseSchema = z.object({
  branchId: objectId,
  supplierId: objectId,
  invoiceNumber: z.string().trim().optional(),
  items: z.array(purchaseItemSchema).min(1),
  purchaseDate: z.coerce.date().optional(),
  notes: z.string().trim().optional(),
});

const listPurchasesQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  supplierId: objectId.optional(),
  receivedStatus: z.enum(['PENDING', 'PARTIAL', 'RECEIVED']).optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID']).optional(),
});

const recordPaymentSchema = z.object({ amount: moneyInput });
const idParamSchema = z.object({ id: objectId });

module.exports = { createPurchaseSchema, listPurchasesQuery, recordPaymentSchema, idParamSchema };
