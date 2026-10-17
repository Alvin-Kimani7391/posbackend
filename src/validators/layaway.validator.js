const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const positiveMoney = z.coerce.number().positive().transform(toCents);
const idParamSchema = z.object({ id: objectId });
const method = z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']); // MPESA = verified PayHero (Kenya); MOBILE_MONEY = any mobile-money rail with a reference (Tanzania)

// ---- layaway
const payInput = z.object({ method, amount: positiveMoney, reference: z.string().trim().max(100).optional(), provider: z.string().trim().max(40).optional() });
const createLayawaySchema = z.object({
  branchId: objectId,
  customerId: objectId,
  items: z.array(z.object({
    productId: objectId, variantId: objectId.optional(), quantity: z.coerce.number().positive(), serialNumbers: z.array(z.string().trim()).optional(),
  })).min(1).max(30),
  dueDate: z.coerce.date(),
  deposit: payInput,
  notes: z.string().trim().max(500).optional(),
});
const layawayPaymentSchema = payInput;
const extendSchema = z.object({ newDueDate: z.coerce.date(), reason: z.string().trim().min(3).max(300) });
const collectSchema = z.object({ collectedByName: z.string().trim().min(2).max(120), idChecked: z.boolean().optional().default(false) });
const cancelSchema = z.object({
  reason: z.string().trim().min(3).max(300),
  cancelledByCustomer: z.boolean().optional().default(true),
  waiveFee: z.boolean().optional().default(false),
  refundMethod: method.optional(),
  refundReference: z.string().trim().max(100).optional(),
  refundProvider: z.string().trim().max(40).optional(),
});
const layawayListQuery = paginationQuery.extend({
  branchId: objectId.optional(), customerId: objectId.optional(), search: z.string().trim().max(60).optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(), overdue: z.coerce.boolean().optional(),
});
const summaryQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional() });

// ---- trade-ins
const money = z.coerce.number().positive().transform(toCents);
const checklistSchema = z.object({
  powersOn: z.boolean().optional(), accountLocksRemoved: z.boolean().optional(), imeiMatchesDevice: z.boolean().optional(), notReportedStolen: z.boolean().optional(),
});
const appraiseSchema = z.object({
  branchId: objectId,
  customerId: objectId.optional(),
  sellerName: z.string().trim().min(2).max(120).optional(),
  sellerPhone: z.string().trim().min(7).max(20).optional(),
  idType: z.enum(['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'ALIEN_ID']),
  idNumber: z.string().trim().min(5).max(30),
  device: z.object({
    category: z.enum(['PHONE', 'TABLET', 'LAPTOP', 'OTHER']).default('PHONE'),
    brand: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(80),
    storage: z.string().trim().max(20).optional(), color: z.string().trim().max(30).optional(),
    serialNumber: z.string().trim().min(3).max(64), serialKind: z.enum(['serial', 'imei']).optional(),
    grade: z.enum(['A', 'B', 'C', 'D']), accessories: z.array(z.string().trim().max(60)).max(20).optional(), notes: z.string().trim().max(500).optional(),
  }),
  checklist: checklistSchema.optional(),
  offer: money,
  resalePrice: money,
});
const acceptSchema = z.object({ checklist: checklistSchema.optional(), ownershipDeclared: z.boolean() });
const cancelTradeInSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const tradeInListQuery = paginationQuery.extend({
  branchId: objectId.optional(), search: z.string().trim().max(60).optional(),
  status: z.enum(['APPRAISED', 'ACCEPTED', 'APPLIED', 'CANCELLED', 'REVERSED']).optional(),
});

module.exports = {
  idParamSchema, createLayawaySchema, layawayPaymentSchema, extendSchema, collectSchema, cancelSchema, layawayListQuery, summaryQuery,
  appraiseSchema, acceptSchema, cancelTradeInSchema, tradeInListQuery,
};