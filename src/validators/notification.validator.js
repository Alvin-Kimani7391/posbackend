const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { EMPLOYEE_RAISABLE_TYPES } = require('../constants/notificationTypes');

const idParamSchema = z.object({ id: objectId });

const listNotificationsQuery = paginationQuery.extend({
  unreadOnly: z.coerce.boolean().optional(),
  type: z.string().optional(),
});

const raiseAlertSchema = z.object({
  branchId: objectId.optional(),
  type: z.enum(EMPLOYEE_RAISABLE_TYPES),
  message: z.string().trim().min(3).max(500),
  data: z.record(z.any()).optional(),
});

module.exports = { idParamSchema, listNotificationsQuery, raiseAlertSchema };