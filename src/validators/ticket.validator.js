const { z } = require('zod');
const { objectId } = require('./common');
const {
  TICKET_STATUSES,
  TICKET_PRIORITIES,
  TICKET_CATEGORIES,
} = require('../constants/ticket');

const idParamSchema = z.object({
  id: objectId,
});

const createTicketSchema = z.object({
  subject: z.string().trim().min(3).max(150),
  description: z.string().trim().min(10).max(3000),

  category: z
    .enum(TICKET_CATEGORIES)
    .default('OTHER'),

  priority: z
    .enum(TICKET_PRIORITIES)
    .default('MEDIUM'),

  errorMessage: z
    .string()
    .trim()
    .max(5000)
    .optional()
    .or(z.literal('')),

  pageUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal('')),

  branchId: objectId.optional(),
});

const replySchema = z.object({
  message: z.string().trim().min(1).max(3000),
});

const listTicketsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),

  status: z
    .enum(TICKET_STATUSES)
    .optional()
    .or(z.literal('')),

  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .or(z.literal('')),
});

/* ====================================================================== */
/* PLATFORM ADMIN                                                        */
/* ====================================================================== */

const adminListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),

  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(15),

  status: z
    .enum(TICKET_STATUSES)
    .optional()
    .or(z.literal('')),

  priority: z
    .enum(TICKET_PRIORITIES)
    .optional()
    .or(z.literal('')),

  businessId: objectId
    .optional()
    .or(z.literal('')),

  awaiting: z
    .enum(['true', 'false'])
    .optional()
    .or(z.literal('')),

  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .or(z.literal('')),

  from: z.coerce.date().optional(),

  to: z.coerce.date().optional(),
});

const adminStatusSchema = z
  .object({
    status: z
      .enum(TICKET_STATUSES)
      .optional(),

    priority: z
      .enum(TICKET_PRIORITIES)
      .optional(),

    resolution: z
      .string()
      .trim()
      .max(3000)
      .optional()
      .or(z.literal('')),
  })
  .refine(
    (data) => data.status !== undefined || data.priority !== undefined,
    {
      message: 'Either status or priority is required',
      path: ['status'],
    }
  );

module.exports = {
  idParamSchema,
  createTicketSchema,
  replySchema,
  listTicketsQuery,
  adminListQuery,
  adminStatusSchema,
};
