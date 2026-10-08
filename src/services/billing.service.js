/**
 * Billing engine + owner-facing reads.
 *  - startSubscription / advanceSubscription : plan phases -> invoices (idempotent, safe with several instances)
 *  - allocatePayment / applyCredit           : oldest-invoice-first allocation, surplus -> credit (transactional)
 *  - reconcile                               : arrears, status, auto-lock / unlock, Business sync
 * All money is integer cents.
 */
const Business = require('../models/Business');
const Sale = require('../models/Sale');
const BillingPlan = require('../models/BillingPlan');
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const ApiError = require('../utils/ApiError');
const withTx = require('../utils/withTx');
const lockCache = require('../utils/lockCache');
const { addDays, addMonths, floorShilling, DAY } = require('../utils/billingDates');
const { BUSINESS_STATUS_MAP } = require('../constants/billing');
const { ROLES } = require('../constants/roles');
const settingsSvc = require('./billing.settings');
const notify = require('./billing.notify');

const MAX_STEPS = 48;

/* ================================ plans ================================ */

// PLACEHOLDER VALUES - edit in the admin plan editor before turning billing on.
const DEFAULT_PLAN = {
  key: 'standard',
  name: 'Standard',
  description: '7-day free trial, 3-month setup payment, then monthly maintenance by usage.',
  isActive: true,
  phases: [
    { key: 'trial', name: 'Free trial', type: 'TRIAL', durationDays: 7 },
    { key: 'setup', name: 'Setup & licence', type: 'INSTALLMENTS', durationMonths: 3, installments: 3, totalAmountCents: 1500000, dueAfterDays: 0 },
    {
      key: 'maintenance', name: 'Monthly maintenance', type: 'RECURRING', intervalMonths: 1, durationMonths: null,
      pricingMode: 'TIERED', tierMetric: 'TRANSACTION_COUNT', dueAfterDays: 0,
      tiers: [
        { label: 'Starter', upTo: 1000, amountCents: 49900 },
        { label: 'Growth', upTo: 3000, amountCents: 74900 },
        { label: 'Pro', upTo: null, amountCents: 109900 },
      ],
    },
  ],
};

async function ensureDefaultPlan() {
  const existing = await BillingPlan.findOne({ key: DEFAULT_PLAN.key });
  if (existing) return existing;
  try { return await BillingPlan.create(DEFAULT_PLAN); }
  catch (err) { if (err.code === 11000) return BillingPlan.findOne({ key: DEFAULT_PLAN.key }); throw err; }
}

async function resolvePlan(planKey) {
  if (planKey) {
    const plan = await BillingPlan.findOne({ key: planKey, isActive: true });
    if (!plan) throw ApiError.badRequest('That plan does not exist or is inactive', 'PLAN_NOT_FOUND');
    return plan;
  }
  const settings = await settingsSvc.get();
  const byKey = await BillingPlan.findOne({ key: settings.defaultPlanKey || 'standard', isActive: true });
  return byKey || ensureDefaultPlan();
}

/* ========================= schedule math (pure) ========================= */

const instalmentsOf = (ph) => ph.installments || ph.durationMonths;
const intervalOf = (ph) => (ph.type === 'INSTALLMENTS' ? ph.durationMonths / instalmentsOf(ph) : ph.intervalMonths || 1);

function phaseEndFor(ph, start) {
  if (ph.type === 'TRIAL') return addDays(start, ph.durationDays);
  if (ph.durationMonths) return addMonths(start, ph.durationMonths);
  return null; // open-ended
}
const dueAtFor = (ph, start, k) => addMonths(start, k * intervalOf(ph));

function invoicesDone(ph, count, start, end) {
  if (ph.type === 'TRIAL') return true;
  if (ph.type === 'INSTALLMENTS') return count >= instalmentsOf(ph);
  return !!end && dueAtFor(ph, start, count) >= end;
}
function nextActionFor(ph, start, end, count) {
  return invoicesDone(ph, count, start, end) ? end || null : dueAtFor(ph, start, count);
}

function enterPhase(sub, plan, index, startAt) {
  const phase = plan.phases[index];
  sub.planId = plan._id; sub.planKey = plan.key; sub.planName = plan.name;
  sub.phaseStartedAt = startAt; sub.phaseInvoiceCount = 0;
  if (!phase) { // plan finished - nothing more to bill
    sub.phaseKey = null; sub.phaseName = null; sub.phaseType = null; sub.phaseEndsAt = null; sub.nextActionAt = null;
    return;
  }
  sub.phaseKey = phase.key; sub.phaseName = phase.name; sub.phaseType = phase.type;
  sub.phaseEndsAt = phaseEndFor(phase, startAt);
  sub.nextActionAt = nextActionFor(phase, startAt, sub.phaseEndsAt, 0);
  if (phase.type === 'TRIAL') sub.trialEndsAt = sub.phaseEndsAt;
}

/* ============================ pricing modes ============================ */
// Add a new pricing strategy here (and to PRICING_MODES + the validator) and plans can use it.
const pricers = {
  async FLAT(phase) { return { amount: phase.amountCents || 0, meta: {} }; },

  async TIERED(phase, { sub, periodStart, interval }) {
    const from = addMonths(periodStart, -interval);
    const match = { businessId: sub.businessId, saleStatus: 'COMPLETED', createdAt: { $gte: from, $lt: periodStart } };
    let value;
    if (phase.tierMetric === 'SALES_VALUE') {
      const r = await Sale.aggregate([{ $match: match }, { $group: { _id: null, t: { $sum: '$total' } } }]);
      value = r[0]?.t || 0;
    } else {
      value = await Sale.countDocuments(match);
    }
    const tiers = [...(phase.tiers || [])].sort((a, b) => (a.upTo == null ? Infinity : a.upTo) - (b.upTo == null ? Infinity : b.upTo));
    const tier = tiers.find((t) => t.upTo == null || value <= t.upTo) || tiers[tiers.length - 1];
    return { amount: tier ? tier.amountCents : 0, meta: { metric: phase.tierMetric, value, tierLabel: tier?.label, from, to: periodStart } };
  },
};

const monthLabel = (d) => new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' });

/** What the NEXT scheduled invoice of this phase will be (read-only; also used for the "upcoming" preview). */
async function priceNext(sub, phase) {
  const k = sub.phaseInvoiceCount;
  const start = sub.phaseStartedAt;
  const interval = intervalOf(phase);
  const dueAt = dueAtFor(phase, start, k);
  const periodEnd = addMonths(start, (k + 1) * interval);
  const dueDate = addDays(dueAt, phase.dueAfterDays || 0);

  if (phase.type === 'INSTALLMENTS') {
    const n = instalmentsOf(phase);
    const issued = await Invoice.aggregate([
      { $match: { subscriptionId: sub._id, planRun: sub.planRun, phaseKey: phase.key } },
      { $group: { _id: null, s: { $sum: '$baseAmount' } } },
    ]);
    const remainingTotal = Math.max((phase.totalAmountCents || 0) - (issued[0]?.s || 0), 0);
    const remainingCount = n - k;
    // Whole shillings; the last instalment absorbs the remainder so the total is always exact.
    const amount = remainingCount <= 1 ? remainingTotal : floorShilling(remainingTotal / remainingCount);
    return { kind: 'INSTALLMENT', amount, description: `${phase.name} - instalment ${k + 1} of ${n}`, periodStart: dueAt, periodEnd, dueAt, dueDate, meta: { instalment: k + 1, of: n } };
  }

  const { amount, meta } = await (pricers[phase.pricingMode || 'FLAT'] || pricers.FLAT)(phase, { sub, periodStart: dueAt, interval });
  return { kind: 'RECURRING', amount, description: `${phase.name} - ${monthLabel(dueAt)}`, periodStart: dueAt, periodEnd, dueAt, dueDate, meta };
}

/* ============================ lifecycle ============================ */

const newInvoiceNumber = () => {
  const d = new Date();
  return `BIL-${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}-${require('crypto').randomBytes(3).toString('hex').toUpperCase()}`;
};

async function syncBusiness(sub) {
  const expiry = sub.status === 'TRIALING' ? sub.trialEndsAt : sub.oldestOverdueAt || sub.nextActionAt || null;
  await Business.updateOne({ _id: sub.businessId }, { $set: {
    subscriptionPlan: sub.planKey || 'none',
    subscriptionStatus: BUSINESS_STATUS_MAP[sub.status] || 'active',
    subscriptionExpiresAt: expiry || undefined,
  } });
  lockCache.invalidate(sub.businessId);
}

/** Creates the subscription (starts the plan's first phase). Idempotent. Call this when a business registers. */
async function startSubscription(businessId, { planKey, startPhaseKey, startAt = new Date() } = {}) {
  const existing = await Subscription.findOne({ businessId });
  if (existing) return existing;
  const plan = await resolvePlan(planKey);
  let index = 0;
  if (startPhaseKey) {
    index = plan.phases.findIndex((p) => p.key === startPhaseKey);
    if (index < 0) throw ApiError.badRequest('That phase does not exist on the plan', 'PHASE_NOT_FOUND');
  }
  const sub = new Subscription({ businessId, startedAt: startAt, status: plan.phases[index]?.type === 'TRIAL' ? 'TRIALING' : 'ACTIVE' });
  enterPhase(sub, plan.toObject(), index, startAt);
  try { await sub.save(); }
  catch (err) { if (err.code === 11000) return Subscription.findOne({ businessId }); throw err; }
  await syncBusiness(sub);
  await notify.event(businessId, 'SUBSCRIPTION_STARTED', `Subscription started on plan "${plan.name}"`, { subscriptionId: sub._id });
  return sub;
}

/** Atomic one-shot claim for a notification key stored on the subscription (trial reminders etc.). */
async function claimSubKey(subId, key) {
  const r = await Subscription.updateOne({ _id: subId, notifiedKeys: { $ne: key } }, { $addToSet: { notifiedKeys: key } });
  return r.modifiedCount === 1;
}

async function generateInvoice(sub, plan, phase, now) {
  const p = await priceNext(sub, phase);
  let invoice = null;

  if (p.amount > 0) {
    for (let attempt = 0; attempt < 3 && !invoice; attempt += 1) {
      try {
        invoice = await Invoice.create({
          businessId: sub.businessId, subscriptionId: sub._id, number: newInvoiceNumber(), kind: p.kind,
          planRun: sub.planRun, phaseKey: phase.key, sequence: sub.phaseInvoiceCount,
          description: p.description, periodStart: p.periodStart, periodEnd: p.periodEnd, dueDate: p.dueDate,
          baseAmount: p.amount, amount: p.amount, meta: p.meta,
          reminderKeys: p.dueDate <= now ? ['due_now'] : [], // the "issued" email already says it is due
          createdBy: 'SYSTEM',
        });
      } catch (err) {
        if (err.code !== 11000) throw err;
        if (err.keyPattern && err.keyPattern.number) continue; // number collision: retry with a new one
        break; // this scheduled invoice already exists (another worker) - just advance
      }
    }
  }

  const nextCount = sub.phaseInvoiceCount + 1;
  await Subscription.updateOne(
    { _id: sub._id, planRun: sub.planRun, phaseKey: phase.key, phaseInvoiceCount: sub.phaseInvoiceCount },
    { $set: { phaseInvoiceCount: nextCount, nextActionAt: nextActionFor(phase, sub.phaseStartedAt, sub.phaseEndsAt, nextCount) } }
  );

  if (invoice) {
    await applyCredit(sub._id);
    const fresh = await Invoice.findById(invoice._id);
    await notify.invoiceIssued(fresh);
  }
}

/** Does everything that is due for one subscription (issue invoices, roll phases) up to `now`. */
async function advanceSubscription(subId, now = new Date()) {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const sub = await Subscription.findById(subId);
    if (!sub || sub.status === 'CANCELLED' || !sub.nextActionAt || sub.nextActionAt > now) return sub;

    const plan = await BillingPlan.findById(sub.planId).lean();
    const idx = plan ? plan.phases.findIndex((p) => p.key === sub.phaseKey) : -1;
    if (idx < 0) {
      await notify.event(sub.businessId, 'PLAN_PHASE_MISSING', `Plan/phase "${sub.phaseKey}" no longer exists - billing paused for this business`, { subscriptionId: sub._id });
      await Subscription.updateOne({ _id: sub._id }, { $set: { nextActionAt: null } });
      return sub;
    }
    const phase = plan.phases[idx];

    if (invoicesDone(phase, sub.phaseInvoiceCount, sub.phaseStartedAt, sub.phaseEndsAt)) {
      const startAt = sub.phaseEndsAt; // phases are contiguous
      const wasTrial = phase.type === 'TRIAL';
      enterPhase(sub, plan, idx + 1, startAt);
      await sub.save();
      await notify.event(sub.businessId, 'PHASE_STARTED', `Moved to phase "${sub.phaseName || 'end of plan'}"`, { subscriptionId: sub._id });
      if (wasTrial) await notify.trialEnded(sub);
      continue;
    }
    await generateInvoice(sub, plan, phase, now);
  }
  return Subscription.findById(subId);
}

/* ===================== allocation (oldest invoice first) ===================== */

async function allocateFIFO(subId, amount, session) {
  const invoices = await Invoice.find({ subscriptionId: subId, status: { $in: ['PENDING', 'PARTIAL'] } })
    .sort({ dueDate: 1, createdAt: 1 }).session(session);
  let remaining = amount;
  const allocations = [];
  for (const inv of invoices) {
    if (remaining <= 0) break;
    const due = inv.amount - inv.amountPaid;
    if (due <= 0) continue;
    const take = Math.min(due, remaining);
    inv.amountPaid += take;
    inv.status = inv.amountPaid >= inv.amount ? 'PAID' : 'PARTIAL';
    if (inv.status === 'PAID') inv.paidAt = new Date();
    await inv.save({ session });
    allocations.push({ invoiceId: inv._id, invoiceNumber: inv.number, amount: take });
    remaining -= take;
  }
  return { allocations, leftover: remaining };
}

/** Applies a SUCCESS payment to invoices (idempotent: only runs while allocatedAt is null). */
async function allocatePayment(paymentId) {
  const payment = await withTx(async (session) => {
    const p = await SubscriptionPayment.findOne({ _id: paymentId, status: 'SUCCESS', allocatedAt: null }).session(session);
    if (!p) return null;
    const sub = await Subscription.findById(p.subscriptionId).session(session);
    if (!sub) throw new Error('Subscription missing for payment');
    const { allocations, leftover } = await allocateFIFO(sub._id, p.amount, session);
    p.allocations = allocations; p.creditAddedCents = leftover; p.allocatedAt = new Date();
    await p.save({ session });
    sub.creditCents += leftover; sub.totalPaidCents += p.amount; sub.lastPaymentAt = new Date();
    await sub.save({ session });
    return p;
  });
  if (!payment) return null;
  await reconcile(payment.subscriptionId);
  await notify.paymentReceived(payment);
  return payment;
}

/** Uses stored account credit to pay open invoices (called when a new invoice is issued / an invoice is voided). */
async function applyCredit(subId) {
  const used = await withTx(async (session) => {
    const sub = await Subscription.findById(subId).session(session);
    if (!sub || sub.creditCents <= 0) return 0;
    const { leftover } = await allocateFIFO(sub._id, sub.creditCents, session);
    const spent = sub.creditCents - leftover;
    if (spent > 0) { sub.creditCents = leftover; await sub.save({ session }); }
    return spent;
  });
  if (used > 0) await notify.event(null, 'CREDIT_APPLIED', `Credit of ${used} cents applied`, { subscriptionId: subId });
  return used;
}

/* ============================ reconcile ============================ */

function deriveStatus(sub) {
  if (sub.status === 'CANCELLED') return 'CANCELLED';
  if (sub.lock?.active) return 'SUSPENDED';
  if (sub.arrearsCents > 0) return 'PAST_DUE';
  if (sub.phaseType === 'TRIAL') return 'TRIALING';
  return 'ACTIVE';
}

/** Recomputes arrears + status, auto-locks / auto-unlocks, syncs the Business, sends transition notices. */
async function reconcile(subId, { now = new Date() } = {}) {
  const sub = await Subscription.findById(subId);
  if (!sub) return null;
  const settings = await settingsSvc.get();

  const open = await Invoice.find({ subscriptionId: sub._id, status: { $in: ['PENDING', 'PARTIAL'] } }).select('amount amountPaid dueDate').lean();
  let openBalance = 0; let arrears = 0; let oldest = null;
  for (const i of open) {
    const bal = i.amount - i.amountPaid;
    openBalance += bal;
    if (i.dueDate <= now) { arrears += bal; if (!oldest || i.dueDate < oldest) oldest = i.dueDate; }
  }
  sub.openBalanceCents = openBalance; sub.arrearsCents = arrears; sub.oldestOverdueAt = oldest;

  const graceDays = sub.graceDaysOverride ?? settings.enforcement?.graceDays ?? 7;
  const exempt = sub.lockExemptUntil && sub.lockExemptUntil > now;
  let change = null;

  if (settings.billingEnabled && !sub.lock?.active && settings.enforcement?.autoSuspendEnabled !== false
      && sub.status !== 'CANCELLED' && arrears > 0 && oldest && now >= addDays(oldest, graceDays) && !exempt) {
    sub.lock = { active: true, reason: 'NON_PAYMENT', at: now, note: `Overdue balance unpaid ${graceDays}+ days` };
    change = 'LOCKED';
  } else if (sub.lock?.active && sub.lock.reason === 'NON_PAYMENT' && arrears === 0) {
    sub.lock = { active: false };
    change = 'UNLOCKED';
  }

  sub.status = deriveStatus(sub);
  await sub.save();
  await syncBusiness(sub);

  if (change === 'LOCKED') await notify.locked(sub, { auto: true });
  if (change === 'UNLOCKED') await notify.restored(sub);
  return sub;
}

/* ============================ owner-facing reads ============================ */

const canSeeAmounts = (user) => !!user && (user.role === ROLES.OWNER || user.role === ROLES.ADMIN || (user.grantedPermissions || []).includes('billing.view'));

async function getStatusLight(businessId, user) {
  const [settings, sub] = await Promise.all([settingsSvc.get(), Subscription.findOne({ businessId }).lean()]);
  if (!settings.billingEnabled || !sub) return { enabled: !!settings.billingEnabled, hasSubscription: !!sub };
  const now = Date.now();
  const out = {
    enabled: true, hasSubscription: true, status: sub.status,
    locked: !!sub.lock?.active, lockReason: sub.lock?.reason || null,
    trialEndsAt: sub.status === 'TRIALING' ? sub.trialEndsAt : null,
    daysLeftInTrial: sub.status === 'TRIALING' && sub.trialEndsAt ? Math.max(Math.ceil((new Date(sub.trialEndsAt) - now) / DAY), 0) : null,
  };
  if (canSeeAmounts(user)) {
    const graceDays = sub.graceDaysOverride ?? settings.enforcement?.graceDays ?? 7;
    out.arrearsCents = sub.arrearsCents; out.creditCents = sub.creditCents; out.openBalanceCents = sub.openBalanceCents;
    out.lockAt = !sub.lock?.active && sub.oldestOverdueAt && settings.enforcement?.autoSuspendEnabled !== false
      ? addDays(sub.oldestOverdueAt, graceDays) : null;
  }
  return out;
}

const paymentOptions = (s) => ({
  stk: { available: !!(s.stk?.enabled && s.stk.channelId && s.stk.credentialsSetAt) },
  manual: {
    available: !!s.manual?.enabled, label: s.manual?.methodLabel, number: s.manual?.number, accountName: s.manual?.accountName,
    accountReference: s.manual?.accountReference, phone: s.manual?.phone, instructions: s.manual?.instructions,
  },
});

/** Read-only preview of what comes next (used by owner overview and admin detail). */
async function describeUpcoming(sub, plan) {
  if (!sub.phaseKey || !plan || sub.status === 'CANCELLED') return null;
  const idx = plan.phases.findIndex((p) => p.key === sub.phaseKey);
  const phase = plan.phases[idx];
  if (!phase) return null;
  if (invoicesDone(phase, sub.phaseInvoiceCount, sub.phaseStartedAt, sub.phaseEndsAt)) {
    const next = plan.phases[idx + 1];
    return { type: phase.type === 'TRIAL' ? 'TRIAL_END' : 'PHASE_CHANGE', at: sub.phaseEndsAt, nextPhaseName: next?.name || null };
  }
  const p = await priceNext(sub, phase);
  return { type: 'INVOICE', at: p.dueDate, amountCents: p.amount, description: p.description, estimated: phase.pricingMode === 'TIERED', meta: p.meta };
}

async function getOverview(businessId) {
  const [settings, sub] = await Promise.all([settingsSvc.get(), Subscription.findOne({ businessId }).lean()]);
  const base = { enabled: !!settings.billingEnabled, paymentOptions: paymentOptions(settings), contact: settings.contact || {} };
  if (!sub) return { ...base, subscription: null };

  const now = new Date();
  const plan = await BillingPlan.findById(sub.planId).lean();
  const phase = plan?.phases.find((p) => p.key === sub.phaseKey) || null;
  const graceDays = sub.graceDaysOverride ?? settings.enforcement?.graceDays ?? 7;

  const [openInvoices, pendingPayments, upcoming, phaseAgg] = await Promise.all([
    Invoice.find({ subscriptionId: sub._id, status: { $in: ['PENDING', 'PARTIAL'] } }).sort({ dueDate: 1 }).lean(),
    SubscriptionPayment.find({ businessId, status: { $in: ['PENDING', 'SUBMITTED'] } }).sort({ createdAt: -1 }).limit(10).select('-rawCallback -rawInitiateResponse').lean(),
    describeUpcoming(sub, plan),
    phase && phase.type === 'INSTALLMENTS'
      ? Invoice.aggregate([{ $match: { subscriptionId: sub._id, planRun: sub.planRun, phaseKey: phase.key, status: { $ne: 'VOID' } } }, { $group: { _id: null, issued: { $sum: '$amount' }, paid: { $sum: '$amountPaid' } } }])
      : Promise.resolve([]),
  ]);

  return {
    ...base,
    subscription: {
      status: sub.status, planKey: sub.planKey, planName: sub.planName,
      phase: sub.phaseKey ? { key: sub.phaseKey, name: sub.phaseName, type: sub.phaseType, startedAt: sub.phaseStartedAt, endsAt: sub.phaseEndsAt } : null,
      trialEndsAt: sub.trialEndsAt, nextActionAt: sub.nextActionAt,
      creditCents: sub.creditCents, arrearsCents: sub.arrearsCents, openBalanceCents: sub.openBalanceCents,
      oldestOverdueAt: sub.oldestOverdueAt, graceDays,
      lockAt: !sub.lock?.active && sub.oldestOverdueAt && settings.enforcement?.autoSuspendEnabled !== false ? addDays(sub.oldestOverdueAt, graceDays) : null,
      lock: { active: !!sub.lock?.active, reason: sub.lock?.reason || null },
      totalPaidCents: sub.totalPaidCents, lastPaymentAt: sub.lastPaymentAt,
    },
    setup: phase && phase.type === 'INSTALLMENTS'
      ? { totalCents: phase.totalAmountCents, instalments: instalmentsOf(phase), issuedCents: phaseAgg[0]?.issued || 0, paidCents: phaseAgg[0]?.paid || 0 }
      : null,
    pricing: phase && phase.type === 'RECURRING' && phase.pricingMode === 'TIERED' ? { metric: phase.tierMetric, tiers: phase.tiers } : null,
    upcoming,
    openInvoices: openInvoices.map((i) => ({ ...i, balanceCents: i.amount - i.amountPaid, overdue: i.dueDate <= now })),
    pendingPayments,
  };
}

async function listInvoices(businessId, { page = 1, limit = 15, status } = {}) {
  const match = { businessId };
  if (status) match.status = status;
  const [items, total] = await Promise.all([
    Invoice.find(match).sort({ dueDate: -1 }).skip((page - 1) * limit).limit(limit).select('-reminderKeys -adjustments').lean(),
    Invoice.countDocuments(match),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function listPayments(businessId, { page = 1, limit = 15, status } = {}) {
  const match = { businessId };
  if (status) match.status = status;
  const [items, total] = await Promise.all([
    SubscriptionPayment.find(match).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-rawCallback -rawInitiateResponse -mpesaMessage -parsed -flags').lean(),
    SubscriptionPayment.countDocuments(match),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

module.exports = {
  DEFAULT_PLAN, ensureDefaultPlan, resolvePlan, enterPhase, syncBusiness,
  startSubscription, advanceSubscription, allocatePayment, applyCredit, reconcile, claimSubKey,
  describeUpcoming, getStatusLight, getOverview, listInvoices, listPayments, deriveStatus,
};