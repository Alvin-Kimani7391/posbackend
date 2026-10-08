const { z } = require('zod');
const { objectId } = require('./common');
const { FIELD_KEYS, OPS, LIFECYCLES } = require('../services/crm.engine');

const ruleSchema = z.object({
  field: z.enum(FIELD_KEYS),
  op: z.enum(OPS),
  value: z.union([z.string().trim().max(80), z.number(), z.boolean(), z.array(z.string().max(40)).max(10)]).optional(),
  value2: z.union([z.string().trim().max(80), z.number()]).optional(),
});

const audienceShape = {
  match: z.enum(['all', 'any']).default('all'),
  rules: z.array(ruleSchema).min(1).max(10),
};

const segmentSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional().default(''),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  ...audienceShape,
});

const previewSchema = z.object(audienceShape);

const listCustomersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(80).optional(),
  lifecycle: z.enum(LIFECYCLES).optional(),
  segmentId: z.string().trim().max(40).optional(),
  sort: z.enum(['spent', 'recent', 'visits', 'newest', 'name']).default('spent'),
});

const settingsSchema = z.object({
  newWindowDays: z.coerce.number().int().min(1).max(365).optional(),
  inactiveDays: z.coerce.number().int().min(7).max(730).optional(),
  frequentMinPurchases: z.coerce.number().int().min(2).max(100).optional(),
  frequentWindowDays: z.coerce.number().int().min(7).max(365).optional(),
  vipMinSpend: z.coerce.number().min(0).max(1000000000).optional(), // KES
  vipMinPurchases: z.coerce.number().int().min(0).max(10000).optional(),
});

const tagsSchema = z.object({ tags: z.array(z.string().trim().min(1).max(24)).max(10) });

const idParam = z.object({ id: objectId });
const segmentIdParam = z.object({ id: objectId });

module.exports = { segmentSchema, previewSchema, listCustomersQuery, settingsSchema, tagsSchema, idParam, segmentIdParam };