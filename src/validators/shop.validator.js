const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');
const { IMPORT_MAX_ROWS } = require('../constants/shop');

const idParam = z.object({ id: objectId });
const money = z.coerce.number().min(0).transform(toCents);
const ids = z.array(objectId).max(500);

// ---- import / export
const importBody = z.object({
  csv: z.string().max(5_000_000).optional(),
  rows: z.array(z.union([z.record(z.any()), z.array(z.any())])).max(IMPORT_MAX_ROWS).optional(),
  dryRun: z.coerce.boolean().optional().default(true),
  mode: z.enum(['CREATE_ONLY', 'UPSERT']).optional().default('CREATE_ONLY'),
  branchId: objectId.optional(),
  createCategories: z.coerce.boolean().optional().default(true),
  defaultTaxRate: z.coerce.number().min(0).max(100).optional().default(0),
});
const importFileForm = z.object({  // multipart form fields (the file itself is field "file")
  dryRun: z.enum(['true', 'false']).optional().default('true').transform((v) => v === 'true'),
  mode: z.enum(['CREATE_ONLY', 'UPSERT']).optional().default('CREATE_ONLY'),
  branchId: objectId.optional(),
  createCategories: z.enum(['true', 'false']).optional().default('true').transform((v) => v === 'true'),
  defaultTaxRate: z.coerce.number().min(0).max(100).optional().default(0),
});
const exportQuery = z.object({ branchId: objectId.optional(), categoryId: objectId.optional() });

// ---- held sales
const heldBody = z.object({
  branchId: objectId, label: z.string().trim().max(60).optional(), customerId: objectId.optional(),
  items: z.array(z.object({ productId: objectId, variantId: objectId.optional(), unitId: objectId.optional(), quantity: z.coerce.number().positive(), discount: money.optional().default(0), note: z.string().trim().max(120).optional() })).min(1).max(100),
  cartDiscount: money.optional().default(0), notes: z.string().trim().max(300).optional(),
});
const heldListQuery = z.object({ branchId: objectId.optional(), mine: z.coerce.boolean().optional() });

// ---- promotions
const promoBase = z.object({
  name: z.string().trim().min(2).max(80), description: z.string().trim().max(300).optional(),
  type: z.enum(['PERCENT', 'AMOUNT_OFF', 'FIXED_PRICE', 'MULTI_BUY']),
  value: z.coerce.number().min(0).optional(), buyQty: z.coerce.number().int().min(2).optional(), payQty: z.coerce.number().int().min(1).optional(),
  scope: z.enum(['ALL', 'PRODUCTS', 'CATEGORIES']).default('PRODUCTS'),
  productIds: ids.optional().default([]), categoryIds: ids.optional().default([]), branchIds: ids.optional().default([]),
  startsAt: z.coerce.date(), endsAt: z.coerce.date(),
  daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).max(7).optional().default([]),
  minQty: z.coerce.number().min(0).optional().default(0),
});
const fixValue = (d) => (d.type === 'AMOUNT_OFF' || d.type === 'FIXED_PRICE') && d.value != null ? { ...d, value: toCents(d.value) } : d;
const promoCheck = (d, ctx) => {
  if (d.type === 'MULTI_BUY' ? !(d.buyQty > d.payQty) : d.value == null) ctx.addIssue({ code: 'custom', message: d.type === 'MULTI_BUY' ? 'Buy quantity must be more than pay quantity' : 'Value is required', path: ['value'] });
  if (d.type === 'PERCENT' && d.value > 100) ctx.addIssue({ code: 'custom', message: 'Percent cannot exceed 100', path: ['value'] });
  if (d.endsAt <= d.startsAt) ctx.addIssue({ code: 'custom', message: 'End must be after start', path: ['endsAt'] });
};
const promotionCreate = promoBase.superRefine(promoCheck).transform(fixValue);
const promotionUpdate = promoBase.partial().transform((d) => (d.type ? fixValue(d) : d));
const promoListQuery = z.object({ state: z.enum(['all', 'active', 'upcoming', 'ended']).optional().default('all') });
const quoteBody = z.object({
  branchId: objectId.optional(),
  lines: z.array(z.object({ productId: objectId, variantId: objectId.optional(), unitId: objectId.optional(), quantity: z.coerce.number().positive() })).min(1).max(100),
});

// ---- prices
const selection = z.object({ productIds: ids.optional(), categoryIds: ids.optional(), brand: z.string().trim().max(80).optional(), all: z.boolean().optional() });
const priceRule = z.object({
  field: z.enum(['sellingPrice', 'costPrice']).default('sellingPrice'),
  mode: z.enum(['PERCENT', 'AMOUNT', 'MARGIN', 'SET']),
  value: z.coerce.number(),
  rounding: z.enum(['NONE', 'NEAREST_1', 'NEAREST_5', 'NEAREST_10', 'NEAREST_50']).optional().default('NONE'),
  endIn99: z.boolean().optional().default(false),
}).superRefine((r, ctx) => { if (r.mode === 'PERCENT' && r.value <= -100) ctx.addIssue({ code: 'custom', message: 'A drop of 100% or more is not allowed', path: ['value'] }); if (r.mode === 'SET' && r.value < 0) ctx.addIssue({ code: 'custom', message: 'Price cannot be negative', path: ['value'] }); })
  .transform((r) => ((r.mode === 'AMOUNT' || r.mode === 'SET') ? { ...r, value: toCents(r.value) } : r));
const priceBody = z.object({ filter: selection, rule: priceRule, allowBelowCost: z.boolean().optional().default(false) });
const historyQuery = z.object({ page: z.coerce.number().int().min(1).optional().default(1), limit: z.coerce.number().int().min(1).max(100).optional().default(20) });

// ---- barcodes
const barcodeGenBody = z.object({ productIds: ids.optional(), categoryId: objectId.optional(), limit: z.coerce.number().int().min(1).max(2000).optional().default(500) });
const labelBody = z.object({ productIds: ids.min(1), copies: z.coerce.number().int().min(1).max(100).optional().default(1) });

// ---- reports
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const eodQuery = z.object({ date: dateStr.optional(), branchId: objectId.optional(), cashierId: objectId.optional() });
const marginQuery = z.object({ from: z.coerce.date(), to: z.coerce.date(), branchId: objectId.optional(), groupBy: z.enum(['product', 'category']).optional().default('product'), limit: z.coerce.number().int().min(1).max(200).optional().default(50) })
  .refine((q) => q.to >= q.from, { message: 'End date must be after start date', path: ['to'] });
const deadQuery = z.object({ days: z.coerce.number().int().min(7).max(730).optional().default(60), branchId: objectId.optional(), limit: z.coerce.number().int().min(1).max(500).optional().default(100) });
const branchOnly = z.object({ branchId: objectId.optional() });
const reorderQuery = z.object({ branchId: objectId.optional(), lookbackDays: z.coerce.number().int().min(7).max(180).optional().default(30), coverDays: z.coerce.number().int().min(3).max(90).optional().default(14), limit: z.coerce.number().int().min(1).max(500).optional().default(200) });
const agingQuery = z.object({ minBalance: z.coerce.number().min(0).optional().default(0.01).transform(toCents), limit: z.coerce.number().int().min(1).max(2000).optional().default(500) });
const statementQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

// ---- onboarding
const seedCategoriesBody = z.object({ names: z.array(z.string().trim().min(1).max(60)).max(40).optional() });

module.exports = {
  idParam, importBody, importFileForm, exportQuery, heldBody, heldListQuery, promotionCreate, promotionUpdate, promoListQuery, quoteBody,
  priceBody, historyQuery, barcodeGenBody, labelBody, eodQuery, marginQuery, deadQuery, branchOnly, reorderQuery, agingQuery, statementQuery, seedCategoriesBody,
};
