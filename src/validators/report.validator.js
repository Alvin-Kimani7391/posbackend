const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const reportQuery = z.object({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const inventoryReportQuery = z.object({ branchId: objectId.optional() });

/**
 * FSFBSFBSKFSFFSF
 * reportDetailQuery - used by the new "expand" drill-down endpoints
 * (/reports/sales/detail, /reports/payments/detail, /reports/expenses/detail).
 * Extends the normal report filters with pagination and the extra filters
 * each detail endpoint understa  nds. Unknown/irrelevant keys are stripped by
 * zod's default behaviour, so the same schema is safe to reuse across all
 * three routes even though not every route uses every field.
 */
const reportDetailQuery = reportQuery.extend({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  // sales/detail
  hasDiscount: z.coerce.boolean().optional(),
  hasRefund: z.coerce.boolean().optional(),
  // payments/detail
  method: z.string().trim().optional(),
  status: z.string().trim().optional(),
  // expenses/detail
  category: z.string().trim().optional(),
});

const auditLogQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  userId: objectId.optional(),
  action: z.string().trim().optional(),
  entityType: z.string().trim().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = { reportQuery, inventoryReportQuery, auditLogQuery };