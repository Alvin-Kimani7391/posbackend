const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const reportQuery = z.object({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const inventoryReportQuery = z.object({ branchId: objectId.optional() });

const auditLogQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  userId: objectId.optional(),
  action: z.string().trim().optional(),
  entityType: z.string().trim().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

module.exports = { reportQuery, inventoryReportQuery, auditLogQuery };