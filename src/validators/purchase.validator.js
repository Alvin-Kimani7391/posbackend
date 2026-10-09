const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const moneyInput = z.coerce.number().nonnegative().transform(toCents);

const purchaseItemSchema = z
  .object({
    productId: objectId,
    variantId: objectId.optional(),
    quantity: z.coerce.number().positive(),
    unitCost: moneyInput,
    taxRate: z.coerce.number().min(0).max(100).optional().default(0),
    discount: moneyInput.optional().default(0),

    // ---- NEW: optional price update applied together with the purchase ----
    // updatePrices=true  -> the product's (or variant's) cost price is set to
    //                       this line's real unit cost, and the optional
    //                       sellingPrice / defaultDiscount below are saved too.
    // Omitted fields are left untouched. Values arrive in KES, stored as cents.
    updatePrices: z.boolean().optional().default(false),
    sellingPrice: moneyInput.optional(),
    defaultDiscount: moneyInput.optional(),
  })
  .superRefine((item, ctx) => {
    if (!item.updatePrices) return;
    if (
      item.sellingPrice !== undefined &&
      item.defaultDiscount !== undefined &&
      item.defaultDiscount > item.sellingPrice
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultDiscount'],
        message: 'Discount cannot be more than the selling price',
      });
    }
  });

const createPurchaseSchema = z.object({
  branchId: objectId,
  supplierId: objectId,
  invoiceNumber: z.string().trim().optional(),
  vatMode: z.enum(['NONE', 'INCLUSIVE', 'EXCLUSIVE']).default('NONE'),
  vatRate: z.coerce.number().min(0).max(100).default(0),
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