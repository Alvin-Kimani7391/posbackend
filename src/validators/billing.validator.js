const { z } = require('zod');
const { objectId } = require('./common');
const { PHASE_TYPES, PRICING_MODES, TIER_METRICS, PAYMENT_METHODS, SUBSCRIPTION_STATUSES, PAYMENT_STATUSES, LIMITS } = require('../constants/billing');

const idParamSchema = z.object({ id: objectId });
const businessParamSchema = z.object({ businessId: objectId });

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),
};

/* ----------------------------- owner side ----------------------------- */
const stkSchema = z.object({
  phone: z.string().trim().min(9).max(15),
  // PayHero charges whole shillings, so STK amounts must be whole shillings.
  amountCents: z.coerce.number().int().min(LIMITS.STK_MIN_CENTS).max(LIMITS.STK_MAX_CENTS).multipleOf(100, 'Amount must be in whole shillings'),
});

const manualSchema = z.object({
  mpesaMessage: z.string().trim().min(20, 'Paste the full M-PESA message').max(1000),
  amountCents: z.coerce.number().int().positive().max(LIMITS.MANUAL_MAX_CENTS).optional(),
});

const listQuery = z.object({ ...paging, status: z.string().trim().max(20).optional().or(z.literal('')) });

/* ------------------------------ admin side ------------------------------ */
const nullableInt = (min, max) => z.preprocess(
  (v) => (v === '' || v === undefined ? null : v),
  z.coerce.number().int().min(min).max(max).nullable()
);
const cents = z.coerce.number().int().min(0).max(1000000000).multipleOf(100, 'Use whole shillings');
const keyStr = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Use 2-40 letters, numbers, - or _');
const nameStr = z.string().trim().min(2).max(60);

const tierSchema = z.object({
  label: z.string().trim().max(40).optional(),
  upTo: nullableInt(0, 1000000000).optional(),
  amountCents: cents,
});

// NB: plain objects here (zod discriminatedUnion can't hold refined objects); cross-field rules live in superRefine below.
const phaseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('TRIAL'), key: keyStr, name: nameStr, durationDays: z.coerce.number().int().min(1).max(365) }),
  z.object({
    type: z.literal('INSTALLMENTS'), key: keyStr, name: nameStr, totalAmountCents: cents,
    durationMonths: z.coerce.number().int().min(1).max(60), installments: z.coerce.number().int().min(1).max(60).optional(),
    dueAfterDays: z.coerce.number().int().min(0).max(60).default(0),
  }),
  z.object({
    type: z.literal('RECURRING'), key: keyStr, name: nameStr, intervalMonths: z.coerce.number().int().min(1).max(12).default(1),
    durationMonths: nullableInt(1, 120).optional(), pricingMode: z.enum(PRICING_MODES).default('FLAT'),
    amountCents: cents.optional(), tierMetric: z.enum(TIER_METRICS).default('TRANSACTION_COUNT'),
    tiers: z.array(tierSchema).max(12).optional(), dueAfterDays: z.coerce.number().int().min(0).max(60).default(0),
  }),
]);

const planBody = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  isActive: z.boolean().optional(),
  phases: z.array(phaseSchema).min(1).max(10),
}).superRefine((d, ctx) => {
  const issue = (message, path) => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (new Set(d.phases.map((p) => p.key)).size !== d.phases.length) issue('Phase keys must be unique', ['phases']);
  d.phases.forEach((p, i) => {
    if (p.type === 'INSTALLMENTS') {
      const n = p.installments || p.durationMonths;
      if (p.durationMonths % n !== 0) issue('Months must divide evenly by the number of instalments', ['phases', i, 'installments']);
    }
    if (p.type === 'RECURRING') {
      if (p.durationMonths && p.durationMonths % p.intervalMonths !== 0) issue('Duration must be a multiple of the interval', ['phases', i, 'durationMonths']);
      if (p.pricingMode === 'FLAT' && p.amountCents == null) issue('Enter the monthly amount', ['phases', i, 'amountCents']);
      if (p.pricingMode === 'TIERED') {
        const t = p.tiers || [];
        if (!t.length) return issue('Add at least one tier', ['phases', i, 'tiers']);
        const nullIdx = t.findIndex((x) => x.upTo == null);
        if (nullIdx !== t.length - 1) issue('Only the LAST tier may have no upper limit, and it must exist', ['phases', i, 'tiers']);
        for (let k = 1; k < t.length - 1; k += 1) if (t[k].upTo <= t[k - 1].upTo) issue('Tier limits must increase', ['phases', i, 'tiers']);
      }
    }
  });
});

const planCreateSchema = planBody.and(z.object({ key: keyStr }));
const planUpdateSchema = planBody;
const planActiveSchema = z.object({ isActive: z.boolean() });

const settingsSchema = z.object({
  billingEnabled: z.boolean().optional(),
  defaultPlanKey: keyStr.optional(),
  stk: z.object({
    enabled: z.boolean().optional(),
    channelId: z.string().trim().min(1).optional(),
    apiUsername: z.string().trim().min(1).optional(),
    apiPassword: z.string().trim().min(1).optional(),
    basicAuthToken: z.string().trim().min(1).optional(),
  }).refine((d) => !(d.apiUsername || d.apiPassword) || (d.apiUsername && d.apiPassword), { message: 'apiUsername and apiPassword must be provided together' })
    .refine((d) => !(d.basicAuthToken && (d.apiUsername || d.apiPassword)), { message: 'Provide either a Basic Auth token OR username/password, not both' }).optional(),
  manual: z.object({
    enabled: z.boolean().optional(), methodLabel: z.string().trim().max(60).optional(), number: z.string().trim().max(30).optional(),
    accountName: z.string().trim().max(80).optional(), accountReference: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(20).optional(), instructions: z.string().trim().max(1000).optional(),
  }).optional(),
  enforcement: z.object({ autoSuspendEnabled: z.boolean().optional(), graceDays: z.coerce.number().int().min(0).max(90).optional() }).optional(),
  reminders: z.object({
    beforeDueDays: z.array(z.coerce.number().int().min(1).max(30)).max(5).optional(),
    overdueDays: z.array(z.coerce.number().int().min(1).max(90)).max(6).optional(),
    trialEndingDays: z.array(z.coerce.number().int().min(1).max(30)).max(4).optional(),
  }).optional(),
  contact: z.object({ supportPhone: z.string().trim().max(30).optional(), supportEmail: z.string().trim().email().optional().or(z.literal('')) }).optional(),
  alertEmails: z.array(z.string().trim().toLowerCase().email()).max(10).optional(),
});

const subsQuery = z.object({
  ...paging,
  status: z.enum(SUBSCRIPTION_STATUSES).optional().or(z.literal('')),
  arrears: z.enum(['0', '1']).optional().or(z.literal('')),
  sort: z.enum(['arrears', 'recent']).optional().or(z.literal('')),
  search: z.string().trim().max(100).optional().or(z.literal('')),
});
const paymentsQuery = z.object({
  ...paging,
  status: z.enum(PAYMENT_STATUSES).optional().or(z.literal('')),
  method: z.enum(PAYMENT_METHODS).optional().or(z.literal('')),
  businessId: objectId.optional().or(z.literal('')),
});

const startSchema = z.object({ planKey: keyStr.optional(), startPhaseKey: keyStr.optional() });
const changePlanSchema = z.object({ planKey: keyStr, startPhaseKey: keyStr.optional() });
const extendTrialSchema = z.object({ days: z.coerce.number().int().min(1).max(90) });
const lockSchema = z.object({ note: z.string().trim().max(300).optional() });
const unlockSchema = z.object({ note: z.string().trim().max(300).optional(), exemptDays: z.coerce.number().int().min(1).max(60).optional() });
const policySchema = z.object({
  graceDaysOverride: nullableInt(0, 90).optional(),
  lockExemptUntil: z.preprocess((v) => (v === '' ? null : v), z.coerce.date().nullable()).optional(),
});
const invoiceCreateSchema = z.object({
  description: z.string().trim().min(3).max(200), amountCents: cents.refine((v) => v > 0, 'Amount must be above zero'),
  dueDate: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.date().optional()),
});
const invoiceAdjustSchema = z.object({
  amountCents: cents.optional(), dueDate: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.date().optional()),
  description: z.string().trim().min(3).max(200).optional(), reason: z.string().trim().min(3).max(300),
});
const voidSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const recordPaymentSchema = z.object({
  amountCents: z.coerce.number().int().positive().max(LIMITS.MANUAL_MAX_CENTS),
  method: z.enum(['MPESA_MANUAL', 'CASH', 'BANK', 'OTHER']),
  reference: z.string().trim().max(120).optional(), note: z.string().trim().max(300).optional(),
  receiptCode: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{9}$/, 'M-PESA codes are 10 characters').optional().or(z.literal('')),
});
const noticeSchema = z.object({
  title: z.string().trim().min(3).max(120), message: z.string().trim().min(3).max(1000),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'), sendEmail: z.boolean().optional(),
});
const approveSchema = z.object({ amountCents: z.coerce.number().int().positive().max(LIMITS.MANUAL_MAX_CENTS).optional(), note: z.string().trim().max(300).optional() });
const rejectSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const backfillSchema = z.object({ planKey: keyStr.optional() });

module.exports = {
  idParamSchema, businessParamSchema, stkSchema, manualSchema, listQuery,
  planCreateSchema, planUpdateSchema, planActiveSchema, settingsSchema, subsQuery, paymentsQuery,
  startSchema, changePlanSchema, extendTrialSchema, lockSchema, unlockSchema, policySchema,
  invoiceCreateSchema, invoiceAdjustSchema, voidSchema, recordPaymentSchema, noticeSchema,
  approveSchema, rejectSchema, backfillSchema,
};