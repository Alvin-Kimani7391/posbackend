const { z } = require('zod');
const { objectId } = require('./common');
const {
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_DISPLAYS,
  ANNOUNCEMENT_FREQUENCIES,
  ANNOUNCEMENT_STATUSES,
  ANNOUNCEMENT_PAGES,
  TARGETABLE_ROLES,
} = require('../constants/announcement');

const idParamSchema = z.object({ id: objectId });

const placementSchema = z.object({
  page: z.enum(ANNOUNCEMENT_PAGES),
  display: z.enum(ANNOUNCEMENT_DISPLAYS),
});

// '' -> null so the admin form can send an empty "ends" field
const nullableDate = z.preprocess(
  (v) => (v === '' ? null : v),
  z.coerce.date().nullable().optional()
);

/** Used for BOTH create (POST) and edit (PUT). */
const announcementSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    message: z.string().trim().min(3).max(1000),
    type: z.enum(ANNOUNCEMENT_TYPES).default('INFO'),

    // [] = everyone
    roles: z
      .array(z.enum(TARGETABLE_ROLES))
      .default([])
      .transform((r) => [...new Set(r)]),

    placements: z
      .array(placementSchema)
      .min(1, 'Pick at least one page')
      .max(ANNOUNCEMENT_PAGES.length)
      .refine((p) => new Set(p.map((x) => x.page)).size === p.length, 'Each page can only be listed once'),

    frequency: z.enum(ANNOUNCEMENT_FREQUENCIES).default('ONCE'),

    startNow: z.boolean().optional(), // true = server uses its own clock as the start
    startsAt: nullableDate,
    endsAt: nullableDate, // null = no end date

    isActive: z.boolean().optional(),
    resend: z.boolean().optional(), // edit only: show again to people who dismissed it
  })
  .superRefine((d, ctx) => {
    const start = d.startNow ? new Date() : d.startsAt || new Date();
    if (d.endsAt && d.endsAt <= start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endsAt'], message: 'End time must be after the start time' });
    }
  });

const activeSchema = z.object({ isActive: z.boolean() });

const adminListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),
  status: z.enum(ANNOUNCEMENT_STATUSES).optional().or(z.literal('')),
  type: z.enum(ANNOUNCEMENT_TYPES).optional().or(z.literal('')),
  search: z.string().trim().max(100).optional().or(z.literal('')),
});

/** Tenant side: which page is asking. */
const activeQuery = z.object({ page: z.enum(ANNOUNCEMENT_PAGES) });

module.exports = { idParamSchema, announcementSchema, activeSchema, adminListQuery, activeQuery };