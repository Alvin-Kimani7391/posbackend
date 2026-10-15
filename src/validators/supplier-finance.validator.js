const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const moneyInput = z.coerce.number().nonnegative().transform(toCents);
const positiveMoney = z.coerce.number().positive().transform(toCents);

const supplierInvoiceSchema = z.object({
  invoiceNumber: z.string().trim().min(1).optional(),
  invoiceDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  supplierInvoiceTotal: moneyInput,   // the total printed on the supplier's invoice (KES)
  note: z.string().trim().max(500).optional(),
});
const approveVarianceSchema = z.object({ note: z.string().trim().max(500).optional(), adjustPayable: z.boolean().optional().default(false) });

const supplierPaymentSchema = z.object({
  supplierId: objectId,
  branchId: objectId.optional(),
  amount: positiveMoney,
  method: z.enum(['CASH', 'MPESA', 'BANK', 'CHEQUE', 'OTHER']).default('CASH'),
  reference: z.string().trim().max(100).optional(),
  paidAt: z.coerce.date().optional(),
  notes: z.string().trim().max(500).optional(),
  allocations: z.array(z.object({ purchaseId: objectId, amount: positiveMoney })).max(100).optional(), // omit = oldest due first
});
const voidPaymentSchema = z.object({ reason: z.string().trim().min(1).max(300) });

const paymentsQuery = paginationQuery.extend({ supplierId: objectId.optional(), status: z.enum(['COMPLETED', 'VOIDED']).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const statementQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const ageingQuery = z.object({ supplierId: objectId.optional(), asOf: z.coerce.date().optional() });
const idParam = z.object({ id: objectId });
const supplierIdParam = z.object({ supplierId: objectId });

module.exports = { supplierInvoiceSchema, approveVarianceSchema, supplierPaymentSchema, voidPaymentSchema, paymentsQuery, statementQuery, ageingQuery, idParam, supplierIdParam };
