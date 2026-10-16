const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const money = z.coerce.number().nonnegative().transform(toCents);
const positiveMoney = z.coerce.number().positive().transform(toCents);
const idParamSchema = z.object({ id: objectId });
const reason = z.string().trim().min(3, 'Give a reason');

// ---- serials
const serialListQuery = paginationQuery.extend({
  branchId: objectId.optional(), productId: objectId.optional(),
  status: z.enum(['in_stock', 'sold', 'damaged', 'returned']).optional(),
  location: z.enum(['RETAIL', 'WAREHOUSE']).optional(),
});
const serialLookupQuery = z.object({ serial: z.string().trim().min(3).max(64) });
const inspectSchema = z.object({ outcome: z.enum(['RESTOCK', 'DAMAGED']), note: z.string().trim().max(300).optional() });
const expiringWarrantyQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), branchId: objectId.optional() });

// ---- warranty claims
const createClaimSchema = z.object({ branchId: objectId, serialNumber: z.string().trim().min(3).max(64), fault: z.string().trim().min(3).max(1000) });
const decideClaimSchema = z.object({
  decision: z.enum(['REPAIR', 'REPLACEMENT', 'REJECT']),
  reason,
  goodwill: z.boolean().optional().default(false),
  replacementSerialNumber: z.string().trim().min(3).max(64).optional(),
  technicianId: objectId.optional(),
  promisedDate: z.coerce.date().optional(),
});
const supplierRmaSchema = z.object({
  reference: z.string().trim().min(1).max(100),
  sentAt: z.coerce.date().optional(),
  outcome: z.enum(['PENDING', 'CREDITED', 'REPLACED', 'REJECTED']).optional(),
  note: z.string().trim().max(500).optional(),
});
const claimListQuery = paginationQuery.extend({
  branchId: objectId.optional(), status: z.enum(['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED']).optional(), serialNumber: z.string().trim().optional(),
});

// ---- repairs
const createRepairSchema = z.object({
  branchId: objectId,
  customerId: objectId.optional(),
  customerName: z.string().trim().min(2).max(120).optional(),
  customerPhone: z.string().trim().min(7).max(20).optional(),
  device: z.object({
    brand: z.string().trim().max(60).optional(),
    model: z.string().trim().max(80).optional(),
    serialNumber: z.string().trim().max(64).optional(),
    condition: z.string().trim().max(300).optional(),
    accessories: z.array(z.string().trim().max(60)).max(20).optional(),
  }),
  fault: z.string().trim().min(3).max(1000),
  technicianId: objectId.optional(),
  promisedDate: z.coerce.date().optional(),
});
const estimateSchema = z.object({
  diagnosis: z.string().trim().max(1000).optional(),
  labour: money.optional(),
  technicianId: objectId.optional(),
  promisedDate: z.coerce.date().optional(),
  addParts: z.array(z.object({ productId: objectId, variantId: objectId.optional(), quantity: z.coerce.number().positive() })).max(50).optional(),
  removePartIds: z.array(objectId).max(50).optional(),
});
const approvalSchema = z.object({ channel: z.enum(['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP']), note: z.string().trim().max(300).optional() });
const partParamSchema = z.object({ id: objectId, partId: objectId });
const actionSchema = z.object({ action: z.enum(['startWork', 'awaitParts', 'ready', 'unrepairable']), note: z.string().trim().max(300).optional() });
const cancelRepairSchema = z.object({ reason });
const repairPaymentSchema = z.object({
  type: z.enum(['DEPOSIT', 'PAYMENT', 'REFUND']),
  method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']),
  amount: positiveMoney,
  reference: z.string().trim().max(100).optional(),
});
const collectSchema = z.object({
  collectedByName: z.string().trim().min(2).max(120),
  idChecked: z.boolean().optional().default(false),
  waiveBalance: z.boolean().optional().default(false),
  waiveReason: z.string().trim().max(300).optional(),
});
const repairListQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  status: z.enum(['RECEIVED', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'READY', 'COLLECTED', 'UNREPAIRABLE', 'CANCELLED']).optional(),
  overdue: z.coerce.boolean().optional(),
});
const repairSummaryQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional() });
const uncollectedQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(14), branchId: objectId.optional() });

module.exports = {
  idParamSchema, partParamSchema,
  serialListQuery, serialLookupQuery, inspectSchema, expiringWarrantyQuery,
  createClaimSchema, decideClaimSchema, supplierRmaSchema, claimListQuery,
  createRepairSchema, estimateSchema, approvalSchema, actionSchema, cancelRepairSchema, repairPaymentSchema, collectSchema, repairListQuery, uncollectedQuery, repairSummaryQuery,
};