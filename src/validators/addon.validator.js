const { z } = require('zod');
const { objectId } = require('./common');
const { ADDON_KEY_RE, ADDON_CURRENCIES, ADDON_BILLING_TYPES } = require('../constants/addons');
const { BUSINESS_TYPES } = require('../constants/businessFeatures');
const keyStr = z.string().trim().toLowerCase().regex(ADDON_KEY_RE, 'Key: letters, numbers, - or _ (2-40, starts with a letter)');
const keyParam = z.object({ key: keyStr });
const bizKeyParam = z.object({ businessId: objectId, key: keyStr });
const businessParam = z.object({ businessId: objectId });
const price = z.object({ currency: z.enum(ADDON_CURRENCIES), amountCents: z.coerce.number().int().min(0).max(2000000000) });
const base = {
  name: z.string().trim().min(2).max(80),
  tagline: z.string().trim().max(200).default(''),
  description: z.string().trim().max(1500).default(''),
  benefits: z.array(z.string().trim().min(1).max(140)).max(10).default([]),
  icon: z.string().trim().max(30).default('star'),
  businessTypes: z.array(z.enum(BUSINESS_TYPES)).max(20).default([]),
  pages: z.array(z.string().trim().regex(/^[a-z0-9_\-]+\.html$/i, 'Use a page file name like hx-live.html')).max(10).default([]),
  prices: z.array(price).max(4).default([]),
  billingType: z.enum(ADDON_BILLING_TYPES).default('RECURRING'),
  intervalMonths: z.coerce.number().int().min(1).max(24).default(1),
  trialDays: z.coerce.number().int().min(0).max(90).default(0),
  graceDays: z.coerce.number().int().min(0).max(30).default(3),
  sortOrder: z.coerce.number().int().min(0).max(10000).default(100),
};
const createBody = z.object({ key: keyStr, ...base, isActive: z.boolean().default(false) }).strict();
const updateBody = z.object(base).partial().strict();
const activeBody = z.object({ isActive: z.boolean() }).strict();
const cancelBody = z.object({ immediate: z.boolean().optional(), reason: z.string().trim().max(300).optional() }).strict();
const grantBody = z.object({ until: z.coerce.date().optional(), note: z.string().trim().max(200).optional() }).strict();
const priceBody = z.object({ priceCents: z.coerce.number().int().min(0).max(2000000000).nullable() }).strict();
const promoteBody = z.object({
  addonKey: keyStr, businessIds: z.array(objectId).max(3000).optional(),
  inApp: z.boolean().default(true), email: z.boolean().default(true),
  subject: z.string().trim().max(120).optional(), message: z.string().trim().max(800).optional(), dryRun: z.boolean().default(false),
}).strict();
const basePlanBody = z.object({ businessType: z.enum(BUSINESS_TYPES), planId: objectId.nullable(), currency: z.enum(ADDON_CURRENCIES).optional() }).strict();
module.exports = { keyParam, bizKeyParam, businessParam, createBody, updateBody, activeBody, cancelBody, grantBody, priceBody, promoteBody, basePlanBody };
