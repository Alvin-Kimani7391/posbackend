const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const moneyInput = z.coerce.number().nonnegative().transform(toCents);

const saleItemSchema = z.object({
  productId: objectId,
  variantId: objectId.optional(),
  quantity: z.coerce.number().positive(),
  discount: moneyInput.optional().default(0),
  overridePrice: moneyInput.optional(),
  batchId: objectId.optional(),
  serialNumbers: z.array(z.string().trim()).optional(),
});

// Note: 'CREDIT' is intentionally not a typed payment method here - credit
// is the implicit unpaid remainder (sale.total - sum(payments)), computed
// by sale.service, not something the client asserts directly.
const paymentInputSchema = z.object({
  method: z.enum(['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER']),
  amount: moneyInput,
  reference: z.string().trim().optional(),
  amountTendered: moneyInput.optional(),
});

const createSaleSchema = z.object({
  branchId: objectId,
  customerId: objectId.optional(),
  items: z.array(saleItemSchema).min(1),
  payments: z.array(paymentInputSchema).default([]),
  cartDiscount: moneyInput.optional().default(0),
  notes: z.string().trim().optional(),
  clientTransactionId: z.string().trim().optional(),
  deviceId: z.string().trim().optional(),
});

const listSalesQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  customerId: objectId.optional(),
  shiftId: objectId.optional(),
  paymentStatus: z.enum(['PAID', 'PARTIAL', 'UNPAID', 'CREDIT']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const cancelSaleSchema = z.object({
  reason: z.string().trim().min(1),
});

const idParamSchema = z.object({ id: objectId });

module.exports = { createSaleSchema, listSalesQuery, cancelSaleSchema, idParamSchema, moneyInput };
