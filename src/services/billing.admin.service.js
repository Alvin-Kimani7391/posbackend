const mongoose = require('mongoose');
const Business = require('../models/Business');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const BillingPlan = require('../models/BillingPlan');
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const BillingEvent = require('../models/BillingEvent');
const PlatformSettings = require('../models/PlatformSettings');
const ApiError = require('../utils/ApiError');
const withTx = require('../utils/withTx');
const lockCache = require('../utils/lockCache');
const { encrypt, maskedHint, decryptJson } = require('../utils/crypto');
const { addDays, monthStartEAT, DAY } = require('../utils/billingDates');
const payhero = require('../integrations/mpesa/payhero.provider');
const settingsSvc = require('./billing.settings');
const notify = require('./billing.notify');
const engine = require('./billing.service');
const payments = require('./billing.payment.service');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paging = (q) => ({ page: Math.max(parseInt(q.page, 10) || 1, 1), limit: Math.min(Math.max(parseInt(q.limit, 10) || 15, 1), 100) });

async function audit(admin, businessId, action, entityType, entityId, newValue, oldValue) {
  try { await AuditLog.create({ businessId, userId: admin._id, action, entityType, entityId, oldValue, newValue }); }
  catch (err) { console.error('[billing audit] failed', err.message); }
  await notify.event(businessId || null, action.toUpperCase().replace(/\./g, '_'), `${admin.name || 'Admin'}: ${action}`, { actorId: admin._id, actorName: admin.name, data: newValue });
}

async function subFor(businessId) {
  if (!mongoose.isValidObjectId(businessId)) throw ApiError.notFound('Business not found');
  const sub = await Subscription.findOne({ businessId });
  if (!sub) throw ApiError.notFound('This business has no subscription yet - start one first', 'NO_SUBSCRIPTION');
  return sub;
}

/* ============================== overview ============================== */
async function overview() {
  const now = new Date();
  const monthStart = monthStartEAT(now);
  const [settings, byStatus, arrears, collected, pendingVerification, trialsEnding, recentPayments, topDefaulters] = await Promise.all([
    settingsSvc.get({ fresh: true }),
    Subscription.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    Subscription.aggregate([{ $match: { arrearsCents: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$arrearsCents' }, n: { $sum: 1 } } }]),
    SubscriptionPayment.aggregate([{ $match: { status: 'SUCCESS', settledAt: { $gte: monthStart } } }, { $group: { _id: null, total: { $sum: '$amount' }, n: { $sum: 1 } } }]),
    SubscriptionPayment.countDocuments({ status: 'SUBMITTED' }),
    Subscription.countDocuments({ status: 'TRIALING', phaseEndsAt: { $gt: now, $lte: addDays(now, 3) } }),
    SubscriptionPayment.find({ status: { $in: ['SUCCESS', 'SUBMITTED'] } }).sort({ createdAt: -1 }).limit(8).populate('businessId', 'name').select('-rawCallback -rawInitiateResponse -mpesaMessage').lean(),
    Subscription.find({ arrearsCents: { $gt: 0 } }).sort({ arrearsCents: -1 }).limit(8).populate('businessId', 'name').lean(),
  ]);
  return {
    billingEnabled: !!settings.billingEnabled,
    counts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
    arrears: { totalCents: arrears[0]?.total || 0, businesses: arrears[0]?.n || 0 },
    collectedThisMonth: { totalCents: collected[0]?.total || 0, payments: collected[0]?.n || 0 },
    pendingVerification, trialsEndingSoon: trialsEnding,
    recentPayments: recentPayments.map((p) => ({ ...p, businessName: p.businessId?.name, businessId: p.businessId?._id })),
    topDefaulters: topDefaulters.map((s) => ({ businessId: s.businessId?._id, businessName: s.businessId?.name, arrearsCents: s.arrearsCents, oldestOverdueAt: s.oldestOverdueAt, status: s.status })),
  };
}

/* ============================ subscriptions ============================ */
async function listSubscriptions(q) {
  const { page, limit } = paging(q);
  const match = {};
  if (q.status) match.status = q.status;
  if (q.arrears === '1') match.arrearsCents = { $gt: 0 };
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    const ids = await Business.find({ $or: [{ name: re }, { phone: re }, { email: re }] }).select('_id').limit(500).lean();
    match.businessId = { $in: ids.map((b) => b._id) };
  }
  const sort = q.sort === 'arrears' ? { arrearsCents: -1 } : { createdAt: -1 };
  const [rows, total] = await Promise.all([
    Subscription.find(match).sort(sort).skip((page - 1) * limit).limit(limit).populate('businessId', 'name phone email status').lean(),
    Subscription.countDocuments(match),
  ]);
  const now = Date.now();
  const items = rows.map((s) => ({
    _id: s._id, businessId: s.businessId?._id, business: s.businessId, status: s.status, planName: s.planName, phaseName: s.phaseName,
    arrearsCents: s.arrearsCents, openBalanceCents: s.openBalanceCents, creditCents: s.creditCents,
    daysOverdue: s.oldestOverdueAt ? Math.max(Math.floor((now - new Date(s.oldestOverdueAt)) / DAY), 0) : 0,
    lastPaymentAt: s.lastPaymentAt, trialEndsAt: s.trialEndsAt, locked: !!s.lock?.active, lockReason: s.lock?.reason,
  }));
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getBusinessBilling(businessId) {
  const sub = await subFor(businessId);
  const [business, plan, invoices, paymentRows, events, settings] = await Promise.all([
    Business.findById(businessId).select('name phone email status subscriptionStatus').lean(),
    BillingPlan.findById(sub.planId).lean(),
    Invoice.find({ subscriptionId: sub._id }).sort({ dueDate: -1 }).limit(100).lean(),
    SubscriptionPayment.find({ subscriptionId: sub._id }).sort({ createdAt: -1 }).limit(100).select('-rawCallback -rawInitiateResponse').lean(),
    BillingEvent.find({ businessId }).sort({ createdAt: -1 }).limit(100).lean(),
    settingsSvc.get(),
  ]);
  const graceDays = sub.graceDaysOverride ?? settings.enforcement?.graceDays ?? 7;
  return {
    business, subscription: sub.toObject(), plan, invoices, payments: paymentRows, events,
    upcoming: await engine.describeUpcoming(sub.toObject(), plan),
    lockAt: !sub.lock?.active && sub.oldestOverdueAt ? addDays(sub.oldestOverdueAt, graceDays) : null,
    graceDays,
  };
}

async function startForBusiness(admin, businessId, { planKey, startPhaseKey }) {
  if (!(await Business.exists({ _id: businessId }))) throw ApiError.notFound('Business not found');
  const sub = await engine.startSubscription(businessId, { planKey, startPhaseKey });
  await audit(admin, businessId, 'admin.billing.start', 'Subscription', sub._id, { planKey: sub.planKey });
  return sub;
}

async function backfill(admin, { planKey }) {
  const have = await Subscription.distinct('businessId');
  const rows = await Business.find({ _id: { $nin: have }, status: { $ne: 'closed' } }).select('_id').lean();
  let started = 0;
  for (const b of rows) { await engine.startSubscription(b._id, { planKey }); started += 1; }
  await audit(admin, null, 'admin.billing.backfill', 'Subscription', undefined, { started, planKey });
  return { started };
}

async function changePlan(admin, businessId, { planKey, startPhaseKey }) {
  const sub = await subFor(businessId);
  const plan = await engine.resolvePlan(planKey);
  let idx = 0;
  if (startPhaseKey) {
    idx = plan.phases.findIndex((p) => p.key === startPhaseKey);
    if (idx < 0) throw ApiError.badRequest('That phase does not exist on the plan', 'PHASE_NOT_FOUND');
  }
  const old = { planKey: sub.planKey, phaseKey: sub.phaseKey };
  sub.planRun += 1;
  engine.enterPhase(sub, plan.toObject(), idx, new Date());
  await sub.save();
  await engine.reconcile(sub._id);
  await audit(admin, businessId, 'admin.billing.change_plan', 'Subscription', sub._id, { planKey: plan.key, phaseKey: sub.phaseKey }, old);
  return Subscription.findById(sub._id);
}

async function extendTrial(admin, businessId, { days }) {
  const sub = await subFor(businessId);
  if (sub.phaseType !== 'TRIAL') throw ApiError.badRequest('This business is no longer in a trial phase', 'NOT_IN_TRIAL');
  const old = sub.phaseEndsAt;
  sub.phaseEndsAt = addDays(sub.phaseEndsAt, days); sub.trialEndsAt = sub.phaseEndsAt; sub.nextActionAt = sub.phaseEndsAt;
  await sub.save();
  await engine.reconcile(sub._id);
  await audit(admin, businessId, 'admin.billing.extend_trial', 'Subscription', sub._id, { days, trialEndsAt: sub.phaseEndsAt }, { trialEndsAt: old });
  return sub;
}

async function lockBusiness(admin, businessId, { note }) {
  const sub = await subFor(businessId);
  if (sub.lock?.active) throw ApiError.conflict('Already locked', 'ALREADY_LOCKED');
  sub.lock = { active: true, reason: 'ADMIN', at: new Date(), by: admin._id, note: note || '' };
  sub.status = engine.deriveStatus(sub);
  await sub.save();
  await engine.syncBusiness(sub);
  await notify.locked(sub, { auto: false, note });
  await audit(admin, businessId, 'admin.billing.lock', 'Subscription', sub._id, { note });
  return sub;
}

async function unlockBusiness(admin, businessId, { note, exemptDays }) {
  const sub = await subFor(businessId);
  sub.lock = { active: false };
  if (exemptDays) sub.lockExemptUntil = addDays(new Date(), exemptDays); // stops the engine re-locking immediately
  sub.status = engine.deriveStatus(sub);
  await sub.save();
  await engine.syncBusiness(sub);
  await notify.restored(sub);
  await audit(admin, businessId, 'admin.billing.unlock', 'Subscription', sub._id, { note, exemptDays });
  return sub;
}

async function setPolicy(admin, businessId, { graceDaysOverride, lockExemptUntil }) {
  const sub = await subFor(businessId);
  if (graceDaysOverride !== undefined) sub.graceDaysOverride = graceDaysOverride === null ? undefined : graceDaysOverride;
  if (lockExemptUntil !== undefined) sub.lockExemptUntil = lockExemptUntil === null ? undefined : lockExemptUntil;
  await sub.save();
  await engine.reconcile(sub._id);
  await audit(admin, businessId, 'admin.billing.policy', 'Subscription', sub._id, { graceDaysOverride, lockExemptUntil });
  return Subscription.findById(sub._id);
}

/* =============================== invoices =============================== */
async function createInvoice(admin, businessId, { description, amountCents, dueDate }) {
  const sub = await subFor(businessId);
  const due = dueDate ? new Date(dueDate) : new Date();
  const inv = await Invoice.create({
    businessId, subscriptionId: sub._id, number: `BIL-ADHOC-${require('crypto').randomBytes(4).toString('hex').toUpperCase()}`,
    kind: 'ONE_OFF', planRun: sub.planRun, phaseKey: 'adhoc', description, dueDate: due,
    baseAmount: amountCents, amount: amountCents, reminderKeys: due <= new Date() ? ['due_now'] : [], createdBy: `ADMIN:${admin._id}`,
  });
  await engine.applyCredit(sub._id);
  await engine.reconcile(sub._id);
  await notify.invoiceIssued(await Invoice.findById(inv._id));
  await audit(admin, businessId, 'admin.billing.invoice.create', 'Invoice', inv._id, { number: inv.number, amountCents, description });
  return inv;
}

async function adjustInvoice(admin, invoiceId, { amountCents, dueDate, description, reason }) {
  const inv = await Invoice.findById(invoiceId);
  if (!inv) throw ApiError.notFound('Invoice not found');
  if (inv.status === 'VOID') throw ApiError.badRequest('A void invoice cannot be edited', 'INVOICE_VOID');
  const before = { amount: inv.amount, dueDate: inv.dueDate, description: inv.description };
  if (amountCents !== undefined) {
    if (amountCents < inv.amountPaid) throw ApiError.badRequest('The new amount cannot be less than what has already been paid. Void the invoice instead.', 'AMOUNT_BELOW_PAID');
    if (amountCents <= 0) throw ApiError.badRequest('Use "void" to cancel an invoice.', 'AMOUNT_INVALID');
    inv.adjustments.push({ at: new Date(), by: String(admin._id), from: inv.amount, to: amountCents, reason });
    inv.amount = amountCents;
    inv.status = inv.amountPaid >= inv.amount ? 'PAID' : inv.amountPaid > 0 ? 'PARTIAL' : 'PENDING';
    if (inv.status === 'PAID' && !inv.paidAt) inv.paidAt = new Date();
  }
  if (dueDate) { inv.dueDate = new Date(dueDate); inv.reminderKeys = []; } // new due date => reminders restart
  if (description) inv.description = description;
  await inv.save();
  await engine.reconcile(inv.subscriptionId);
  await audit(admin, inv.businessId, 'admin.billing.invoice.adjust', 'Invoice', inv._id, { amountCents, dueDate, description, reason }, before);
  return inv;
}

async function voidInvoice(admin, invoiceId, { reason }) {
  const refunded = await withTx(async (session) => {
    const inv = await Invoice.findById(invoiceId).session(session);
    if (!inv) throw ApiError.notFound('Invoice not found');
    if (inv.status === 'VOID') throw ApiError.conflict('Already void', 'INVOICE_VOID');
    const paid = inv.amountPaid;
    inv.status = 'VOID'; inv.voidedAt = new Date(); inv.voidReason = reason; inv.amountPaid = 0;
    await inv.save({ session });
    if (paid > 0) await Subscription.updateOne({ _id: inv.subscriptionId }, { $inc: { creditCents: paid } }, { session }); // paid money is never lost
    return { inv, paid };
  });
  await engine.applyCredit(refunded.inv.subscriptionId);
  await engine.reconcile(refunded.inv.subscriptionId);
  await audit(admin, refunded.inv.businessId, 'admin.billing.invoice.void', 'Invoice', refunded.inv._id, { reason, movedToCredit: refunded.paid });
  return refunded.inv;
}

/* =============================== payments =============================== */
async function recordPayment(admin, businessId, { amountCents, method, reference, note, receiptCode }) {
  const sub = await subFor(businessId);
  const payment = await SubscriptionPayment.create({
    businessId, subscriptionId: sub._id, initiatedBy: admin._id, source: 'ADMIN', method, status: 'SUCCESS',
    amount: amountCents, claimedAmount: amountCents, reference: `BLA-${require('crypto').randomBytes(6).toString('hex').toUpperCase()}`,
    resultDesc: reference || '', settledAt: new Date(),
    ...(receiptCode ? { mpesaReceiptNumber: receiptCode.toUpperCase(), receiptKey: receiptCode.toUpperCase() } : {}),
    review: { by: admin._id, byName: admin.name, at: new Date(), note: note || '' },
  }).catch((err) => {
    if (err.code === 11000) throw ApiError.conflict('That receipt code is already recorded.', 'MPESA_ALREADY_SUBMITTED');
    throw err;
  });
  await engine.allocatePayment(payment._id);
  await audit(admin, businessId, 'admin.billing.payment.record', 'SubscriptionPayment', payment._id, { amountCents, method, reference });
  return SubscriptionPayment.findById(payment._id);
}

async function listPayments(q) {
  const { page, limit } = paging(q);
  const match = {};
  if (q.status) match.status = q.status;
  if (q.method) match.method = q.method;
  if (q.businessId) match.businessId = new mongoose.Types.ObjectId(q.businessId);
  const [rows, total] = await Promise.all([
    SubscriptionPayment.find(match).sort(q.status === 'SUBMITTED' ? { createdAt: 1 } : { createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('businessId', 'name phone').select('-rawCallback -rawInitiateResponse').lean(),
    SubscriptionPayment.countDocuments(match),
  ]);
  return { items: rows.map((p) => ({ ...p, businessName: p.businessId?.name, businessPhone: p.businessId?.phone, businessId: p.businessId?._id })), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getPayment(id) {
  const p = await SubscriptionPayment.findById(id).populate('businessId', 'name phone email').select('-rawCallback -rawInitiateResponse').lean();
  if (!p) throw ApiError.notFound('Payment not found');
  const similar = await SubscriptionPayment.find({
    businessId: p.businessId._id, _id: { $ne: p._id }, status: 'SUCCESS', amount: p.claimedAmount ?? p.amount,
    createdAt: { $gte: addDays(p.createdAt, -2), $lte: addDays(p.createdAt, 2) },
  }).select('method amount reference mpesaReceiptNumber settledAt').lean();
  const sub = await Subscription.findOne({ businessId: p.businessId._id }).select('arrearsCents openBalanceCents creditCents').lean();
  return { payment: { ...p, businessName: p.businessId.name, businessId: p.businessId._id }, similarPayments: similar, account: sub };
}

const approvePayment = (admin, id, body) => payments.approveManual(admin, id, body).then(async (p) => { await audit(admin, p.businessId, 'admin.billing.payment.approve', 'SubscriptionPayment', p._id, { amount: p.amount, code: p.mpesaReceiptNumber }); return p; });
const rejectPayment = (admin, id, body) => payments.rejectManual(admin, id, body).then(async (p) => { await audit(admin, p.businessId, 'admin.billing.payment.reject', 'SubscriptionPayment', p._id, { reason: body.reason }); return p; });

/* ============================ notices / reminders ============================ */
async function sendNotice(admin, businessId, { title, message, severity, sendEmail }) {
  if (!(await Business.exists({ _id: businessId }))) throw ApiError.notFound('Business not found');
  await notify.custom({ businessId, title, message, severity, sendEmailToo: sendEmail !== false, actor: admin });
  return { sent: true };
}

async function sendReminderNow(admin, businessId) {
  const sub = await subFor(businessId);
  const inv = await Invoice.findOne({ subscriptionId: sub._id, status: { $in: ['PENDING', 'PARTIAL'] } }).sort({ dueDate: 1 });
  if (!inv) throw ApiError.badRequest('There is nothing outstanding to remind about.', 'NOTHING_DUE');
  const settings = await settingsSvc.get();
  const graceDays = sub.graceDaysOverride ?? settings.enforcement?.graceDays ?? 7;
  await notify.reminder(inv, 'manual', { daysOverdue: Math.max(Math.floor((Date.now() - inv.dueDate) / DAY), 0), lockAt: addDays(inv.dueDate, graceDays) });
  await audit(admin, businessId, 'admin.billing.remind', 'Invoice', inv._id, { number: inv.number });
  return { sent: true, invoice: inv.number };
}

/* ================================== plans ================================== */
async function listPlans() {
  await engine.ensureDefaultPlan();
  const [plans, counts] = await Promise.all([
    BillingPlan.find().sort({ createdAt: 1 }).lean(),
    Subscription.aggregate([{ $group: { _id: '$planId', n: { $sum: 1 } } }]),
  ]);
  const map = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
  return { items: plans.map((p) => ({ ...p, subscribers: map[String(p._id)] || 0 })) };
}

async function getPlan(id) {
  const plan = await BillingPlan.findById(id).lean();
  if (!plan) throw ApiError.notFound('Plan not found');
  return { plan };
}

async function createPlan(admin, body) {
  try {
    const plan = await BillingPlan.create({ ...body, createdBy: admin._id, updatedBy: admin._id });
    await audit(admin, null, 'admin.billing.plan.create', 'BillingPlan', plan._id, { key: plan.key });
    return plan;
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A plan with that key already exists', 'PLAN_KEY_EXISTS');
    throw err;
  }
}

async function updatePlan(admin, id, body) {
  const plan = await BillingPlan.findById(id);
  if (!plan) throw ApiError.notFound('Plan not found');
  const keys = body.phases.map((p) => p.key);
  const inUse = await Subscription.aggregate([{ $match: { planId: plan._id, status: { $ne: 'CANCELLED' }, phaseKey: { $ne: null } } }, { $group: { _id: '$phaseKey', n: { $sum: 1 } } }]);
  for (const u of inUse) {
    const next = body.phases.find((p) => p.key === u._id);
    const prev = plan.phases.find((p) => p.key === u._id);
    if (!next) throw ApiError.conflict(`${u.n} business(es) are currently in phase "${u._id}". Keep that phase key, or move them to another plan first.`, 'PLAN_PHASE_IN_USE');
    if (prev && prev.type !== next.type) throw ApiError.conflict(`Phase "${u._id}" is in use - its type cannot be changed.`, 'PLAN_PHASE_IN_USE');
  }
  const before = plan.toObject().phases;
  plan.name = body.name; plan.description = body.description || ''; plan.phases = body.phases; plan.updatedBy = admin._id;
  if (body.isActive !== undefined) plan.isActive = body.isActive;
  await plan.save();
  await audit(admin, null, 'admin.billing.plan.update', 'BillingPlan', plan._id, { key: plan.key, phases: keys }, { phases: before });
  return plan;
}

async function setPlanActive(admin, id, isActive) {
  const plan = await BillingPlan.findById(id);
  if (!plan) throw ApiError.notFound('Plan not found');
  const settings = await settingsSvc.get();
  if (!isActive && plan.key === settings.defaultPlanKey) throw ApiError.badRequest('Pick another default plan before deactivating this one.', 'PLAN_IS_DEFAULT');
  plan.isActive = isActive; await plan.save();
  await audit(admin, null, 'admin.billing.plan.active', 'BillingPlan', plan._id, { isActive });
  return plan;
}

/* ================================= settings ================================= */
async function getSettingsStatus() {
  const s = await settingsSvc.get({ fresh: true });
  const { _id, __v, ...rest } = s;
  return { ...rest, stk: { ...s.stk, credentials: maskedHint(s.stk?.credentialsSetAt ? 'x' : null) } };
}

async function updateSettings(admin, body) {
  const s = await settingsSvc.getWithSecrets();
  const changed = [];
  const merge = (target, patch, label) => Object.keys(patch || {}).forEach((k) => { if (patch[k] !== undefined) { target[k] = patch[k]; changed.push(`${label}.${k}`); } });

  if (body.defaultPlanKey !== undefined) {
    if (!(await BillingPlan.exists({ key: body.defaultPlanKey, isActive: true }))) throw ApiError.badRequest('That plan does not exist or is inactive', 'PLAN_NOT_FOUND');
    s.defaultPlanKey = body.defaultPlanKey; changed.push('defaultPlanKey');
  }
  if (body.billingEnabled !== undefined) {
    if (body.billingEnabled && !(await BillingPlan.exists({ key: s.defaultPlanKey, isActive: true }))) {
      throw ApiError.badRequest('Create and activate the default plan before enabling billing.', 'BILLING_NO_PLAN');
    }
    s.billingEnabled = body.billingEnabled; changed.push('billingEnabled');
  }
  if (body.stk) {
    const k = body.stk;
    if (k.enabled !== undefined) { s.stk.enabled = k.enabled; changed.push('stk.enabled'); }
    if (k.channelId !== undefined) { s.stk.channelId = k.channelId; changed.push('stk.channelId'); }
    if (k.basicAuthToken) { s.stk.credentialsBlob = encrypt({ basicAuthToken: k.basicAuthToken }); s.stk.credentialsSetAt = new Date(); changed.push('stk.credentials'); }
    else if (k.apiUsername && k.apiPassword) { s.stk.credentialsBlob = encrypt({ apiUsername: k.apiUsername, apiPassword: k.apiPassword }); s.stk.credentialsSetAt = new Date(); changed.push('stk.credentials'); }
    if (s.stk.enabled && (!s.stk.channelId || !s.stk.credentialsBlob)) throw ApiError.badRequest('Set a channel ID and PayHero credentials before enabling STK payments', 'BILLING_STK_INCOMPLETE');
    s.stk.updatedBy = admin._id;
  }
  merge(s.manual, body.manual, 'manual');
  merge(s.enforcement, body.enforcement, 'enforcement');
  merge(s.reminders, body.reminders, 'reminders');
  merge(s.contact, body.contact, 'contact');
  if (body.alertEmails !== undefined) { s.alertEmails = body.alertEmails; changed.push('alertEmails'); }

  await s.save();
  settingsSvc.invalidate();
  await audit(admin, null, 'admin.billing.settings.update', 'PlatformSettings', s._id, { changedFields: changed }); // field names only, never values
  return getSettingsStatus();
}

async function testStk() {
  const s = await settingsSvc.getWithSecrets();
  if (!s.stk?.credentialsBlob) throw ApiError.badRequest('No PayHero credentials saved yet', 'BILLING_STK_NOT_CONFIGURED');
  try {
    await payhero.getTransactionStatus({ credentials: decryptJson(s.stk.credentialsBlob), reference: 'connection-test' });
    return { ok: true, message: 'PayHero credentials accepted' };
  } catch (err) {
    if (err.code === 'MPESA_STATUS_CHECK_FAILED' && !/unauthor/i.test(err.message)) return { ok: true, message: 'PayHero credentials accepted' };
    return { ok: false, message: err.message };
  }
}

const runCycle = () => require('../jobs/billing.job').runCycle({ force: true });

module.exports = {
  overview, listSubscriptions, getBusinessBilling, startForBusiness, backfill, changePlan, extendTrial,
  lockBusiness, unlockBusiness, setPolicy, createInvoice, adjustInvoice, voidInvoice, recordPayment,
  listPayments, getPayment, approvePayment, rejectPayment, sendNotice, sendReminderNow,
  listPlans, getPlan, createPlan, updatePlan, setPlanActive, getSettingsStatus, updateSettings, testStk, runCycle,
};