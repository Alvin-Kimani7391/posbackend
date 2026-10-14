const { z } = require('zod');
const { paginationQuery } = require('./common');

const tpl = z.string().trim().max(320).optional();
const hour = (min, max) => z.coerce.number().int().min(min).max(max);

const updateSettingsSchema = z.object({
  senderId: z.string().trim().max(11).optional(),
  quietHours: z.object({ enabled: z.boolean().optional(), startHour: hour(0, 23).optional(), endHour: hour(1, 24).optional() }).optional(),
  ready: z.object({ enabled: z.boolean().optional(), template: tpl }).optional(),
  readyReminder: z.object({ enabled: z.boolean().optional(), afterDays: z.array(z.coerce.number().int().min(1).max(90)).min(1).max(5).optional(), template: tpl }).optional(),
  serviceDue: z.object({ enabled: z.boolean().optional(), daysBefore: hour(0, 60).optional(), kmWindow: hour(0, 10000).optional(), template: tpl, overdueTemplate: tpl }).optional(),
  warrantyExpiring: z.object({ enabled: z.boolean().optional(), daysBefore: hour(1, 90).optional(), template: tpl }).optional(),
  insuranceExpiring: z.object({ enabled: z.boolean().optional(), daysBefore: hour(1, 90).optional(), template: tpl }).optional(),
}).strict();

const previewSchema = z.object({
  kind: z.enum(['ready', 'readyReminder', 'serviceDue', 'serviceOverdue', 'warrantyExpiring', 'insuranceExpiring']),
  template: z.string().trim().max(320).optional(),
});

const messagesQuery = paginationQuery.extend({
  purpose: z.enum(['READY', 'READY_REMINDER', 'SERVICE_DUE', 'SERVICE_OVERDUE', 'WARRANTY_EXPIRING', 'INSURANCE_EXPIRING']).optional(),
  status: z.enum(['queued', 'sending', 'sent', 'delivered', 'failed']).optional(),
});

module.exports = { updateSettingsSchema, previewSchema, messagesQuery };