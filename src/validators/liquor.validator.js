const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');
const { CATEGORIES, AGE_MODES, EMPTIES_MODES, CONTAINER_KINDS, TOT_COUNT_TYPES } = require('../constants/liquor');

const idParam = z.object({ id: objectId });
const productIdParam = z.object({ productId: objectId });
const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = z.coerce.number().min(0).transform(toCents);
const range = z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: objectId.optional() }).refine((q) => q.to >= q.from, { message: 'End date must be after start date', path: ['to'] });

const settingsBody = z.object({
  licence: z.object({ number: z.string().trim().max(60).optional(), type: z.string().trim().max(80).optional(), issuer: z.string().trim().max(80).optional(), premises: z.string().trim().max(120).optional(), issuedAt: z.coerce.date().optional(), expiresAt: z.coerce.date().optional() }).optional(),
  blockWhenLicenceExpired: z.boolean().optional(), licenceWarnDays: z.coerce.number().int().min(0).max(365).optional(),
  tradingHours: z.object({ enabled: z.boolean().optional(), byDay: z.array(z.object({ day: z.coerce.number().int().min(0).max(6), closed: z.boolean().optional().default(false), open: hhmm.optional(), close: hhmm.optional() })).max(7).optional() }).optional(),
  closedDates: z.array(z.object({ date: ymd, reason: z.string().trim().max(100).optional() })).max(400).optional(),
  age: z.object({ minAge: z.coerce.number().int().min(16).max(25).optional(), mode: z.enum(AGE_MODES).optional() }).optional(),
  maxBottlesPerSale: z.coerce.number().int().min(0).max(1000).optional(),
  emptiesMode: z.enum(EMPTIES_MODES).optional(),
});

const detailsBody = z.object({
  category: z.enum(CATEGORIES).optional(), isAlcohol: z.boolean().optional(),
  abv: z.coerce.number().min(0).max(100).optional(), volumeMl: z.coerce.number().min(1).max(100000).optional(), vintage: z.coerce.number().int().min(1800).max(2100).optional(),
  country: z.string().trim().max(60).optional(), region: z.string().trim().max(60).optional(), producer: z.string().trim().max(80).optional(),
  exciseCentsPerUnit: money.optional(),
  containerTypeId: objectId.nullable().optional(), containersPerUnit: z.coerce.number().min(0).max(1000).optional(),
  tot: z.object({ bottleProductId: objectId, ml: z.coerce.number().min(1).max(1000) }).nullable().optional(),
  syncTotCost: z.boolean().optional(),
});
const detailsList = z.object({ category: z.enum(CATEGORIES).optional(), alcoholOnly: z.coerce.boolean().optional(), search: z.string().trim().max(60).optional(), missing: z.coerce.boolean().optional(), page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(200).optional().default(50) });
const totProductBody = z.object({ ml: z.coerce.number().min(1).max(1000), price: money.optional(), name: z.string().trim().min(2).max(120).optional(), barcode: z.string().trim().max(40).optional() });
const totCostQuery = z.object({ ml: z.coerce.number().min(1).max(1000) });

const containerCreate = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(CONTAINER_KINDS).optional().default('BOTTLE'), deposit: money.optional().default(0), createDepositProduct: z.boolean().optional().default(true) });
const containerUpdate = z.object({ name: z.string().trim().min(2).max(80).optional(), kind: z.enum(CONTAINER_KINDS).optional(), deposit: money.optional(), active: z.boolean().optional() });
const qty = z.coerce.number().int().positive().max(100000);
const refundBody = z.object({ containerTypeId: objectId, quantity: qty, branchId: objectId, method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'OTHER']).optional().default('CASH'), customerId: objectId.optional(), reference: z.string().trim().max(100).optional(), note: z.string().trim().max(200).optional() });
const supplierMoveBody = z.object({ containerTypeId: objectId, quantity: qty, supplierId: objectId.optional(), branchId: objectId.optional(), note: z.string().trim().max(200).optional() });
const adjustBody = z.object({ containerTypeId: objectId, delta: z.coerce.number().int().refine((n) => n !== 0, 'Cannot be zero'), reason: z.string().trim().min(3).max(200), branchId: objectId.optional() });
const movementsQuery = z.object({ containerTypeId: objectId.optional(), page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(200).optional().default(50) });

const countBody = z.object({ branchId: objectId, bottleProductId: objectId, measuredMl: z.coerce.number().min(0).max(1_000_000), reason: z.string().trim().max(200).optional() });
const wasteBody = z.object({ branchId: objectId, bottleProductId: objectId, ml: z.coerce.number().positive().max(100000), type: z.enum(['WASTE', 'COMP']), reason: z.string().trim().min(3).max(200) });
const poolsQuery = z.object({ branchId: objectId.optional() });

const salesQuery = range.and(z.object({ groupBy: z.enum(['category', 'product']).optional().default('category') }));
const checksQuery = z.object({ from: z.coerce.date(), to: z.coerce.date(), outcome: z.enum(['PASSED', 'REFUSED']).optional(), branchId: objectId.optional(), page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(200).optional().default(50) });
const pageRange = z.object({ from: z.coerce.date(), to: z.coerce.date(), page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(200).optional().default(50) });
const branchOnly = z.object({ branchId: objectId.optional() });

module.exports = { idParam, productIdParam, settingsBody, detailsBody, detailsList, totProductBody, totCostQuery, containerCreate, containerUpdate, refundBody, supplierMoveBody, adjustBody, movementsQuery, countBody, wasteBody, poolsQuery, range, salesQuery, checksQuery, pageRange, branchOnly, TOT_COUNT_TYPES };
