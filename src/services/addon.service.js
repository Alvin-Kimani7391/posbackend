/**
 * Add-on billing: catalogue (admin), subscribe / cancel / resume (owner), grants + promotions (admin), renewals (job).
 * An add-on is billed with ordinary subscription Invoices (meta.addon = true) so every payment route (STK, pasted M-PESA, admin-recorded, credit) works.
 * Access starts when the invoice is PAID (syncPaid, called from billing.reconcile). Add-on invoices NEVER count towards the account lock.
 */
const crypto = require('crypto');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const BillingAddon = require('../models/BillingAddon');
const BillingPlan = require('../models/BillingPlan');
const BusinessAddon = require('../models/BusinessAddon');
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const ApiError = require('../utils/ApiError');
const { addDays, addMonths } = require('../utils/billingDates');
const { money, fmtDate } = require('../utils/emailTemplates');
const { ROLES } = require('../constants/roles');
const { LIFETIME_MONTHS, DEFAULT_ADDONS, RENEWAL_LEAD_DAYS, ABANDON_PENDING_DAYS, DEFAULT_GRACE_DAYS } = require('../constants/addons');
const ent = require('./addon.entitlement');
const notify = require('./billing.notify');

const engine = () => require('./billing.service'); // lazy: billing.service calls back into syncPaid
const DAY = 24 * 3600 * 1000;
const APP = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const cta = () => (APP() ? { label: 'See premium features', url: `${APP()}/billing.html#addons` } : null);
const monthLabel = (d) => new Intl.DateTimeFormat('en-KE', { month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' }).format(new Date(d));
const safe = async (label, fn) => { try { return await fn(); } catch (e) { console.error(`[addons] ${label} failed:`, e.message); return null; } };

async function audit(admin, businessId, action, entityId, newValue) {
  try { await AuditLog.create({ businessId: businessId || undefined, userId: admin._id, action, entityType: 'BillingAddon', entityId, newValue }); }
  catch (e) { console.error('[addons audit]', e.message); }
}
const log = (ba, type, note, by = 'SYSTEM') => { ba.history.push({ at: new Date(), type, note, by }); if (ba.history.length > 40) ba.history.splice(0, ba.history.length - 40); };
const oneTime = (a) => !!a && a.billingType === 'ONE_TIME';
const termMonths = (a) => (oneTime(a) ? LIFETIME_MONTHS : a.intervalMonths || 1);
const priceFor = (addon, currency) => { const p = (addon.prices || []).find((x) => x.currency === currency); return p ? p.amountCents : undefined; };
const canManage = (u) => !!u && (u.role === ROLES.OWNER || u.role === ROLES.ADMIN || (u.grantedPermissions || []).includes('billing.pay'));
const publicView = (a, currency) => ({
  key: a.key, name: a.name, tagline: a.tagline, description: a.description, benefits: a.benefits || [], icon: a.icon, pages: a.pages || [],
  priceCents: priceFor(a, currency) ?? null, currency, intervalMonths: a.intervalMonths, billingType: a.billingType || 'RECURRING', trialDays: a.trialDays || 0,
});
const cleanPrices = (prices = []) => { const seen = new Set(); return prices.filter((p) => (seen.has(p.currency) ? false : seen.add(p.currency))); };

/* ============================ catalogue (admin) ============================ */
async function adminListCatalog() {
  const [addons, counts] = await Promise.all([
    BillingAddon.find().sort({ sortOrder: 1, name: 1 }).lean(),
    BusinessAddon.aggregate([{ $group: { _id: { k: '$addonKey', s: '$status', c: '$complimentary' }, n: { $sum: 1 } } }]),
  ]);
  const stat = {};
  for (const c of counts) {
    const s = (stat[c._id.k] ||= { active: 0, pending: 0, expired: 0, cancelled: 0, complimentary: 0 });
    if (c._id.c) s.complimentary += c.n;
    if (c._id.s === 'ACTIVE') s.active += c.n; else if (c._id.s === 'PENDING_PAYMENT') s.pending += c.n;
    else if (c._id.s === 'EXPIRED') s.expired += c.n; else if (c._id.s === 'CANCELLED') s.cancelled += c.n;
  }
  const zero = { active: 0, pending: 0, expired: 0, cancelled: 0, complimentary: 0 };
  return { addons: addons.map((a) => ({ ...a, stats: stat[a.key] || zero })), starterAvailable: DEFAULT_ADDONS.some((d) => !addons.find((a) => a.key === d.key)) };
}
async function adminCreate(admin, body) {
  if (await BillingAddon.exists({ key: body.key })) throw ApiError.conflict('A feature with that key already exists', 'ADDON_EXISTS');
  const doc = await BillingAddon.create({ ...body, prices: cleanPrices(body.prices), createdBy: admin._id, updatedBy: admin._id });
  ent.invalidateCatalog(); await audit(admin, null, 'admin.addon.create', doc._id, { key: doc.key });
  return doc;
}
async function adminUpdate(admin, key, body) {
  const doc = await BillingAddon.findOne({ key });
  if (!doc) throw ApiError.notFound('Feature not found');
  const rest = { ...body }; delete rest.key;
  if (rest.prices) rest.prices = cleanPrices(rest.prices);
  Object.assign(doc, rest, { updatedBy: admin._id }); await doc.save();
  ent.invalidateCatalog(); await audit(admin, null, 'admin.addon.update', doc._id, { key, fields: Object.keys(rest) });
  return doc;
}
async function adminSetActive(admin, key, isActive) {
  const doc = await BillingAddon.findOne({ key });
  if (!doc) throw ApiError.notFound('Feature not found');
  if (isActive && !(doc.prices || []).length) throw ApiError.badRequest('Add at least one price before switching this feature on', 'ADDON_NOT_PRICED');
  doc.isActive = !!isActive; doc.updatedBy = admin._id; await doc.save();
  ent.invalidateCatalog(); await audit(admin, null, isActive ? 'admin.addon.activate' : 'admin.addon.deactivate', doc._id, { key });
  return doc;
}
async function adminRemove(admin, key) {
  const doc = await BillingAddon.findOne({ key });
  if (!doc) throw ApiError.notFound('Feature not found');
  if (await BusinessAddon.exists({ addonKey: key })) throw ApiError.conflict('Businesses have used this feature. Switch it off instead of deleting it.', 'ADDON_IN_USE');
  await doc.deleteOne(); ent.invalidateCatalog(); await audit(admin, null, 'admin.addon.delete', doc._id, { key });
  return { deleted: true };
}
async function adminSeedStarter(admin) {
  let added = 0;
  for (const d of DEFAULT_ADDONS) {
    const r = await BillingAddon.updateOne({ key: d.key }, { $setOnInsert: { ...d, createdBy: admin._id } }, { upsert: true });
    if (r.upsertedCount) added += 1;
  }
  ent.invalidateCatalog(); await audit(admin, null, 'admin.addon.seed', null, { added });
  return { added };
}

/* ================================ invoices ================================ */
async function issueInvoice(sub, ba, addon, amount, { periodStart, periodEnd, dueDate, renewal = false }) {
  let invoice = null;
  for (let i = 0; i < 3 && !invoice; i += 1) {
    try {
      invoice = await Invoice.create({
        businessId: sub.businessId, subscriptionId: sub._id, number: `BIL-ADDON-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        kind: 'ONE_OFF', currency: sub.currency || 'KES', planRun: sub.planRun, phaseKey: `addon:${addon.key}`,
        description: `${addon.name} add-on - ${oneTime(addon) ? 'one-time purchase' : monthLabel(periodStart)}${!oneTime(addon) && addon.intervalMonths > 1 ? ` (${addon.intervalMonths} months)` : ''}`,
        periodStart, periodEnd, dueDate, baseAmount: amount, amount, reminderKeys: dueDate <= new Date() ? ['due_now'] : [],
        meta: { addon: true, addonKey: addon.key, businessAddonId: String(ba._id), renewal }, createdBy: renewal ? 'SYSTEM' : 'OWNER',
      });
    } catch (e) { if (e.code !== 11000) throw e; }
  }
  if (!invoice) throw ApiError.internal('Could not create the invoice. Please try again.');
  await BusinessAddon.updateOne({ _id: ba._id }, { $set: { pendingInvoiceId: invoice._id } });
  await engine().applyCredit(sub._id);
  await engine().reconcile(sub._id); // -> syncPaid() activates the add-on if credit already paid it
  await notify.invoiceIssued(await Invoice.findById(invoice._id));
  return invoice;
}
async function voidUnpaid(invoiceId, reason) {
  if (!invoiceId) return;
  const r = await Invoice.updateOne({ _id: invoiceId, status: 'PENDING', amountPaid: 0 }, { $set: { status: 'VOID', voidedAt: new Date(), voidReason: reason } });
  if (r.modifiedCount) { const inv = await Invoice.findById(invoiceId).select('subscriptionId').lean(); if (inv) await engine().reconcile(inv.subscriptionId); }
}
const invoiceView = (inv) => inv && ({ id: inv._id, number: inv.number, amountCents: inv.amount, balanceCents: Math.max(inv.amount - inv.amountPaid, 0), dueDate: inv.dueDate, status: inv.status, currency: inv.currency, description: inv.description });

/** Called from billing.reconcile(): PAID add-on invoices become access; VOID ones are cleared. Idempotent (atomic claim). */
async function syncPaid(businessId) {
  const pending = await BusinessAddon.find({ businessId, pendingInvoiceId: { $ne: null } });
  for (const ba of pending) {
    await safe(`sync ${ba.addonKey}`, async () => {
      const inv = await Invoice.findById(ba.pendingInvoiceId);
      if (!inv) { await BusinessAddon.updateOne({ _id: ba._id }, { $unset: { pendingInvoiceId: 1 } }); return; }
      if (inv.status !== 'PAID' && inv.status !== 'VOID') return;
      const prev = await BusinessAddon.findOneAndUpdate({ _id: ba._id, pendingInvoiceId: inv._id }, { $unset: { pendingInvoiceId: 1 } }, { new: false });
      if (!prev) return;
      const addon = await BillingAddon.findOne({ key: prev.addonKey }).lean();
      const now = new Date();
      if (inv.status === 'VOID') {
        if (prev.status === 'PENDING_PAYMENT') await BusinessAddon.updateOne({ _id: prev._id }, { $set: { status: 'CANCELLED', cancelledAt: now } });
        ent.invalidateBusiness(businessId); return;
      }
      const interval = oneTime(addon) ? LIFETIME_MONTHS : prev.intervalMonths || addon?.intervalMonths || 1;
      const continuing = prev.status === 'ACTIVE' && prev.currentPeriodEnd && inv.periodStart && new Date(prev.currentPeriodEnd) >= new Date(inv.periodStart.getTime() - 60000);
      let start = continuing ? inv.periodStart : now; let end = continuing ? inv.periodEnd : addMonths(now, interval);
      if (end < now) { start = now; end = addMonths(now, interval); }
      const set = { status: 'ACTIVE', isTrial: false, currentPeriodStart: start, currentPeriodEnd: end, priceCents: inv.baseAmount };
      if (!prev.startedAt) set.startedAt = now;
      await BusinessAddon.updateOne({ _id: prev._id }, { $set: set, $push: { history: { $each: [{ at: now, type: continuing ? 'RENEWED' : 'ACTIVATED', note: inv.number, by: 'SYSTEM' }], $slice: -40 } } });
      ent.invalidateBusiness(businessId);
      await notify.notifyOwners({
        businessId, type: 'BILLING_ADDON', title: `${addon?.name || prev.addonKey} is ${continuing ? 'renewed' : 'now active'}`,
        message: `Paid through ${fmtDate(end)}. Thank you!`, data: { addonKey: prev.addonKey },
        email: { subject: `${addon?.name || 'Add-on'} ${continuing ? 'renewed' : 'activated'}`, heading: continuing ? 'Add-on renewed' : 'Premium feature activated', paragraphs: [`${addon?.name || prev.addonKey} is active on your account.`], rows: [['Paid through', fmtDate(end)], ['Amount', money(inv.baseAmount, inv.currency)]] },
        eventType: continuing ? 'ADDON_RENEWED' : 'ADDON_ACTIVATED',
      });
    });
  }
}

/* ================================ owner side ================================ */
async function ownerView(businessId, user, { forAdmin = false } = {}) {
  const [business, sub, catalog, owned] = await Promise.all([
    Business.findById(businessId).select('businessType currency name').lean(),
    Subscription.findOne({ businessId }).select('currency status').lean(),
    BillingAddon.find(forAdmin ? {} : { isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
    BusinessAddon.find({ businessId }).lean(),
  ]);
  if (!business) throw ApiError.notFound('Business not found');
  const currency = (sub && sub.currency) || business.currency || 'KES';
  const byKey = new Map(owned.map((o) => [o.addonKey, o]));
  const invIds = owned.map((o) => o.pendingInvoiceId).filter(Boolean);
  const invs = invIds.length ? await Invoice.find({ _id: { $in: invIds } }).lean() : [];
  const invById = new Map(invs.map((i) => [String(i._id), i]));
  const manage = forAdmin || canManage(user); const now = new Date(); const rows = [];
  for (const a of catalog) {
    const ba = byKey.get(a.key);
    if (!ent.applies(a, business.businessType) && !ba) continue;
    const e = ent.evaluate(ba, a, now); const base = publicView(a, currency);
    const price = ba?.priceOverrideCents ?? base.priceCents;
    let label = 'LOCKED';
    if (e.entitled) label = e.reason === 'TRIAL' ? 'TRIAL' : ba.cancelAtPeriodEnd ? 'CANCELLING' : e.reason === 'GRACE' ? 'GRACE' : e.reason === 'COMPLIMENTARY' ? 'COMPLIMENTARY' : 'ACTIVE';
    else if (ba?.status === 'PENDING_PAYMENT') label = 'PENDING_PAYMENT';
    rows.push({
      ...base, priceCents: price, enforced: !!a.isActive, state: label, entitled: e.entitled || !a.isActive, until: oneTime(a) && !ba?.isTrial ? null : e.until,
      trialAvailable: !ba && (a.trialDays || 0) > 0, cancelAtPeriodEnd: !!ba?.cancelAtPeriodEnd,
      ...(manage ? { pendingInvoice: invoiceView(invById.get(String(ba?.pendingInvoiceId))) || null, complimentary: !!ba?.complimentary, priceOverrideCents: ba?.priceOverrideCents ?? null, history: forAdmin ? ba?.history || [] : undefined } : {}),
    });
  }
  const monthly = rows.filter((r) => ['ACTIVE', 'CANCELLING', 'GRACE'].includes(r.state)).filter((r) => r.billingType !== 'ONE_TIME').reduce((s, r) => s + (r.priceCents || 0) / (r.intervalMonths || 1), 0);
  return { currency, canManage: manage, businessType: business.businessType, addons: rows, monthlyCents: Math.round(monthly) };
}

async function subscribe(businessId, user, key) {
  const addon = await BillingAddon.findOne({ key: String(key).toLowerCase(), isActive: true });
  if (!addon) throw ApiError.notFound('That feature is not available', 'ADDON_NOT_FOUND');
  const business = await Business.findById(businessId).select('businessType').lean();
  if (!business || !ent.applies(addon, business.businessType)) throw ApiError.badRequest('That feature is not available for your type of business', 'ADDON_NOT_AVAILABLE');
  let sub = await Subscription.findOne({ businessId });
  if (!sub) sub = await engine().startSubscription(businessId);
  if (sub.status === 'CANCELLED') throw ApiError.badRequest('Your subscription is cancelled. Contact support.', 'SUBSCRIPTION_CANCELLED');
  const currency = sub.currency || 'KES'; const now = new Date();
  let ba = await BusinessAddon.findOne({ businessId, addonKey: addon.key });
  if (ba) {
    const e = ent.evaluate(ba, addon, now);
    if (ba.status === 'PENDING_PAYMENT' && ba.pendingInvoiceId) {
      const open = await Invoice.findById(ba.pendingInvoiceId);
      if (open && ['PENDING', 'PARTIAL'].includes(open.status)) return { key: addon.key, invoice: invoiceView(open), already: true };
    }
    if (e.entitled && ba.status === 'ACTIVE' && ba.cancelAtPeriodEnd) return resume(businessId, user, addon.key);
    if (e.entitled && ba.status === 'ACTIVE' && !ba.cancelAtPeriodEnd) throw ApiError.conflict('This feature is already active', 'ADDON_ALREADY_ACTIVE');
  }
  const price = ba?.priceOverrideCents ?? priceFor(addon, currency);
  if (price == null) throw ApiError.conflict(`This feature has no ${currency} price yet. Contact support.`, 'ADDON_NOT_PRICED');
  const first = !ba;
  if (!ba) ba = new BusinessAddon({ businessId, addonKey: addon.key, source: 'OWNER' });
  Object.assign(ba, { currency, intervalMonths: termMonths(addon), priceCents: price, cancelAtPeriodEnd: false, cancelledAt: undefined, cancelReason: undefined, isTrial: false });
  if (first && addon.trialDays > 0) {
    Object.assign(ba, { status: 'ACTIVE', isTrial: true, startedAt: now, currentPeriodStart: now, currentPeriodEnd: addDays(now, addon.trialDays) });
    log(ba, 'TRIAL_STARTED', `${addon.trialDays} days`, String(user._id)); await ba.save(); ent.invalidateBusiness(businessId);
    return { key: addon.key, trial: true, until: ba.currentPeriodEnd };
  }
  if (price === 0) {
    Object.assign(ba, { status: 'ACTIVE', startedAt: ba.startedAt || now, currentPeriodStart: now, currentPeriodEnd: addMonths(now, termMonths(addon)) });
    log(ba, 'ACTIVATED', 'free', String(user._id)); await ba.save(); ent.invalidateBusiness(businessId);
    return { key: addon.key, free: true, until: ba.currentPeriodEnd };
  }
  ba.status = 'PENDING_PAYMENT'; log(ba, 'REQUESTED', money(price, currency), String(user._id)); await ba.save();
  const invoice = await issueInvoice(sub, ba, addon, price, { periodStart: now, periodEnd: addMonths(now, termMonths(addon)), dueDate: now });
  ent.invalidateBusiness(businessId);
  const fresh = await Invoice.findById(invoice._id);
  return { key: addon.key, invoice: invoiceView(fresh), activated: fresh.status === 'PAID' };
}

async function cancel(businessId, user, key, { immediate = false, reason } = {}) {
  const ba = await BusinessAddon.findOne({ businessId, addonKey: String(key).toLowerCase() });
  if (!ba || !['ACTIVE', 'PENDING_PAYMENT'].includes(ba.status)) throw ApiError.notFound('This feature is not active', 'ADDON_NOT_ACTIVE');
  const addon = await BillingAddon.findOne({ key: ba.addonKey }).lean();
  const now = new Date(); const pendingId = ba.pendingInvoiceId; let outcome;
  if (ba.status === 'PENDING_PAYMENT' || immediate || ba.isTrial || oneTime(addon)) {
    Object.assign(ba, { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, cancelAtPeriodEnd: false, pendingInvoiceId: undefined });
    if (!ba.complimentary) ba.currentPeriodEnd = now;
    outcome = 'ended_now';
  } else {
    Object.assign(ba, { cancelAtPeriodEnd: true, cancelledAt: now, cancelReason: reason, pendingInvoiceId: undefined });
    outcome = 'ends_at_period_end';
  }
  log(ba, 'CANCELLED', outcome, String(user._id)); await ba.save();
  await voidUnpaid(pendingId, 'Add-on cancelled'); ent.invalidateBusiness(businessId);
  await notify.notifyOwners({
    businessId, type: 'BILLING_ADDON', title: `${addon?.name || ba.addonKey} cancelled`,
    message: outcome === 'ended_now' ? 'The feature was switched off.' : `You keep access until ${fmtDate(ba.currentPeriodEnd)}. No further charges.`,
    data: { addonKey: ba.addonKey }, eventType: 'ADDON_CANCELLED',
  });
  return { key: ba.addonKey, outcome, accessUntil: outcome === 'ended_now' ? null : ba.currentPeriodEnd };
}
async function resume(businessId, user, key) {
  const ba = await BusinessAddon.findOne({ businessId, addonKey: String(key).toLowerCase() });
  const addon = ba && (await BillingAddon.findOne({ key: ba.addonKey }).lean());
  if (!ba || ba.status !== 'ACTIVE' || !ba.cancelAtPeriodEnd || !ent.evaluate(ba, addon).entitled) throw ApiError.conflict('Nothing to resume', 'ADDON_NOT_CANCELLING');
  Object.assign(ba, { cancelAtPeriodEnd: false, cancelledAt: undefined, cancelReason: undefined }); log(ba, 'RESUMED', '', String(user._id));
  await ba.save(); ent.invalidateBusiness(businessId);
  return { key: ba.addonKey, resumed: true };
}

/* ========================= admin: per business ========================= */
const adminBusinessView = (businessId) => ownerView(businessId, null, { forAdmin: true });
async function adminGrant(admin, businessId, key, { until, note } = {}) {
  const addon = await BillingAddon.findOne({ key });
  if (!addon) throw ApiError.notFound('Feature not found');
  if (!(await Business.exists({ _id: businessId }))) throw ApiError.notFound('Business not found');
  let ba = await BusinessAddon.findOne({ businessId, addonKey: key });
  if (!ba) ba = new BusinessAddon({ businessId, addonKey: key, status: 'ACTIVE', source: 'ADMIN', startedAt: new Date() });
  ba.complimentary = true; ba.complimentaryUntil = until ? new Date(until) : undefined;
  log(ba, 'GRANTED', note || (until ? `until ${fmtDate(until)}` : 'no end date'), String(admin._id)); await ba.save();
  ent.invalidateBusiness(businessId); await audit(admin, businessId, 'admin.addon.grant', addon._id, { key, until, note });
  return ba;
}
async function adminRevoke(admin, businessId, key) {
  const ba = await BusinessAddon.findOne({ businessId, addonKey: key });
  if (!ba) throw ApiError.notFound('This business does not have that feature');
  const pendingId = ba.pendingInvoiceId;
  Object.assign(ba, { complimentary: false, complimentaryUntil: undefined, status: 'CANCELLED', cancelledAt: new Date(), cancelAtPeriodEnd: false, currentPeriodEnd: new Date(), pendingInvoiceId: undefined });
  log(ba, 'REVOKED', 'by admin', String(admin._id)); await ba.save();
  await voidUnpaid(pendingId, 'Add-on revoked by admin'); ent.invalidateBusiness(businessId); await audit(admin, businessId, 'admin.addon.revoke', null, { key });
  return ba;
}
async function adminSetPrice(admin, businessId, key, priceCents) {
  let ba = await BusinessAddon.findOne({ businessId, addonKey: key });
  if (!ba) { if (priceCents == null) return null; ba = new BusinessAddon({ businessId, addonKey: key, status: 'CANCELLED', source: 'ADMIN' }); }
  ba.priceOverrideCents = priceCents == null ? undefined : priceCents; log(ba, 'PRICE', priceCents == null ? 'catalogue price' : String(priceCents), String(admin._id)); await ba.save();
  await audit(admin, businessId, 'admin.addon.price', null, { key, priceCents });
  return ba;
}
/** Grandfather: every existing business the feature is sold to keeps it free (optionally until a date). */
async function adminGrantExisting(admin, key, { until, note } = {}) {
  const addon = await BillingAddon.findOne({ key }).lean();
  if (!addon) throw ApiError.notFound('Feature not found');
  const q = { status: 'active' }; if (addon.businessTypes?.length) q.businessType = { $in: addon.businessTypes };
  const ids = await Business.find(q).select('_id').lean();
  const hist = { at: new Date(), type: 'GRANTED', note: note || 'existing customer', by: String(admin._id) };
  let n = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const r = await BusinessAddon.bulkWrite(ids.slice(i, i + 500).map((b) => ({ updateOne: {
      filter: { businessId: b._id, addonKey: key },
      update: { $set: { complimentary: true, ...(until ? { complimentaryUntil: new Date(until) } : {}) }, $setOnInsert: { status: 'ACTIVE', source: 'ADMIN', startedAt: new Date(), currency: 'KES', intervalMonths: addon.intervalMonths }, $push: { history: { $each: [hist], $slice: -40 } } },
      upsert: true } })));
    n += (r.upsertedCount || 0) + (r.modifiedCount || 0);
  }
  ent.invalidateCatalog(); await audit(admin, null, 'admin.addon.grant_existing', addon._id, { key, until, count: n });
  return { businesses: ids.length, granted: n };
}

/* ============================ admin: promote ============================ */
async function adminPromote(admin, { addonKey, businessIds, inApp = true, email = true, subject, message, dryRun = false }) {
  const addon = await BillingAddon.findOne({ key: addonKey }).lean();
  if (!addon) throw ApiError.notFound('Feature not found');
  const q = { status: 'active' }; if (addon.businessTypes?.length) q.businessType = { $in: addon.businessTypes };
  if (businessIds?.length) q._id = { $in: businessIds };
  const biz = await Business.find(q).select('_id currency name').limit(3000).lean();
  const owned = await BusinessAddon.find({ addonKey, businessId: { $in: biz.map((b) => b._id) } }).lean();
  const byBiz = new Map(owned.map((o) => [String(o.businessId), o]));
  const targets = biz.filter((b) => !ent.evaluate(byBiz.get(String(b._id)), addon).entitled);
  if (dryRun) return { eligible: biz.length, targeted: targets.length, sent: 0 };
  const title = subject || `Unlock ${addon.name}`; const body = message || addon.tagline || `${addon.name} is now available for your business.`;
  let sent = 0;
  for (let i = 0; i < targets.length; i += 10) {
    await Promise.all(targets.slice(i, i + 10).map((b) => safe(`promote ${b._id}`, async () => {
      const cur = b.currency === 'TZS' ? 'TZS' : 'KES'; const price = priceFor(addon, cur);
      await notify.notifyOwners({
        businessId: b._id, type: 'BILLING_ADDON', title, message: body, data: { addonKey, promo: true }, inApp,
        email: email ? { subject: title, heading: title, paragraphs: [body, ...(addon.benefits || []).map((x) => `- ${x}`)], rows: price != null ? [['Price', oneTime(addon) ? `${money(price, cur)} (one-time)` : `${money(price, cur)} / ${addon.intervalMonths === 1 ? 'month' : `${addon.intervalMonths} months`}`], ...(addon.trialDays ? [['Free trial', `${addon.trialDays} days`]] : [])] : [], cta: cta() } : undefined,
        eventType: 'ADDON_PROMO',
      });
      sent += 1;
    })));
  }
  await audit(admin, null, 'admin.addon.promote', addon._id, { key: addonKey, targeted: targets.length, sent, inApp, email });
  return { eligible: biz.length, targeted: targets.length, sent };
}

/* ===================== base plan per business type ===================== */
async function adminBasePlans() { return { plans: await BillingPlan.find().select('key name currency isActive businessTypes').sort({ createdAt: 1 }).lean() }; }
async function adminSetBasePlan(admin, { businessType, planId, currency }) {
  if (!planId) { await BillingPlan.updateMany({ businessTypes: businessType, ...(currency ? { currency } : {}) }, { $pull: { businessTypes: businessType } }); await audit(admin, null, 'admin.addon.baseplan', null, { businessType, planId: null }); return { cleared: true }; }
  const plan = await BillingPlan.findById(planId);
  if (!plan) throw ApiError.notFound('Plan not found');
  await BillingPlan.updateMany({ currency: plan.currency, businessTypes: businessType, _id: { $ne: plan._id } }, { $pull: { businessTypes: businessType } });
  await BillingPlan.updateOne({ _id: plan._id }, { $addToSet: { businessTypes: businessType } });
  await audit(admin, null, 'admin.addon.baseplan', plan._id, { businessType, planKey: plan.key });
  return { plan: plan.key, businessType };
}

/* ================================== job ================================== */
async function runRenewals(now = new Date()) {
  const cat = new Map((await BillingAddon.find().lean()).map((a) => [a.key, a]));
  // 1. renewal invoices, RENEWAL_LEAD_DAYS before the paid-through date
  const dueSoon = await BusinessAddon.find({ status: 'ACTIVE', cancelAtPeriodEnd: false, pendingInvoiceId: null, currentPeriodEnd: { $ne: null, $lte: addDays(now, RENEWAL_LEAD_DAYS) } }).limit(500);
  for (const ba of dueSoon) await safe(`renew ${ba._id}`, async () => {
    const addon = cat.get(ba.addonKey);
    if (!addon || !addon.isActive) return;
    if (oneTime(addon) && !ba.isTrial) return; // one-time purchase: never renews
    if (ba.complimentary && (!ba.complimentaryUntil || ba.complimentaryUntil > ba.currentPeriodEnd)) return;
    const sub = await Subscription.findOne({ businessId: ba.businessId });
    if (!sub || sub.status === 'CANCELLED') return;
    const price = ba.priceOverrideCents ?? priceFor(addon, ba.currency || sub.currency || 'KES');
    if (price == null) return;
    const interval = oneTime(addon) ? LIFETIME_MONTHS : ba.intervalMonths || addon.intervalMonths || 1;
    if (price === 0) { await BusinessAddon.updateOne({ _id: ba._id }, { $set: { currentPeriodStart: ba.currentPeriodEnd, currentPeriodEnd: addMonths(ba.currentPeriodEnd, interval) } }); ent.invalidateBusiness(ba.businessId); return; }
    await issueInvoice(sub, ba, addon, price, { periodStart: ba.currentPeriodEnd, periodEnd: addMonths(ba.currentPeriodEnd, interval), dueDate: ba.currentPeriodEnd, renewal: true });
  });
  // 2. end of the road: cancelled-at-period-end, or renewal unpaid past grace
  const lapsed = await BusinessAddon.find({ status: 'ACTIVE', currentPeriodEnd: { $ne: null, $lt: now } }).limit(500);
  for (const ba of lapsed) await safe(`expire ${ba._id}`, async () => {
    const addon = cat.get(ba.addonKey);
    if (oneTime(addon) && !ba.isTrial && !ba.cancelAtPeriodEnd) return;
    if (ba.cancelAtPeriodEnd) { await BusinessAddon.updateOne({ _id: ba._id, status: 'ACTIVE' }, { $set: { status: 'CANCELLED' } }); ent.invalidateBusiness(ba.businessId); return; }
    if (now.getTime() <= new Date(ba.currentPeriodEnd).getTime() + (addon?.graceDays ?? DEFAULT_GRACE_DAYS) * DAY) return;
    const r = await BusinessAddon.updateOne({ _id: ba._id, status: 'ACTIVE' }, { $set: { status: 'EXPIRED' }, $unset: { pendingInvoiceId: 1 }, $push: { history: { $each: [{ at: now, type: 'EXPIRED', note: 'renewal not paid', by: 'SYSTEM' }], $slice: -40 } } });
    if (!r.modifiedCount) return;
    await voidUnpaid(ba.pendingInvoiceId, 'Add-on expired'); ent.invalidateBusiness(ba.businessId);
    await notify.notifyOwners({
      businessId: ba.businessId, type: 'BILLING_ADDON', title: `${addon?.name || ba.addonKey} was switched off`,
      message: 'The renewal was not paid. Upgrade again any time to get it back.', data: { addonKey: ba.addonKey },
      email: { subject: `${addon?.name || 'Premium feature'} was switched off`, heading: 'Premium feature switched off', paragraphs: ['We did not receive the renewal payment, so this feature is locked. Your data is safe - upgrade again and it comes straight back.'], cta: cta() },
      eventType: 'ADDON_EXPIRED',
    });
  });
  // 3. activation invoices nobody paid
  const stale = await BusinessAddon.find({ status: 'PENDING_PAYMENT', updatedAt: { $lt: addDays(now, -ABANDON_PENDING_DAYS) } }).limit(200);
  for (const ba of stale) await safe(`abandon ${ba._id}`, async () => {
    await BusinessAddon.updateOne({ _id: ba._id, status: 'PENDING_PAYMENT' }, { $set: { status: 'CANCELLED', cancelledAt: now }, $unset: { pendingInvoiceId: 1 } });
    await voidUnpaid(ba.pendingInvoiceId, 'Add-on request expired unpaid'); ent.invalidateBusiness(ba.businessId);
  });
  // 4. heads-up (once): trial ending / cancelling feature ending
  const soon = await BusinessAddon.find({ status: 'ACTIVE', currentPeriodEnd: { $gt: now, $lte: addDays(now, 3) }, $or: [{ isTrial: true }, { cancelAtPeriodEnd: true }] }).limit(300);
  for (const ba of soon) await safe(`notice ${ba._id}`, async () => {
    const key = `ending_${new Date(ba.currentPeriodEnd).getTime()}`;
    const c = await BusinessAddon.updateOne({ _id: ba._id, notifiedKeys: { $ne: key } }, { $addToSet: { notifiedKeys: key } });
    if (!c.modifiedCount) return;
    const addon = cat.get(ba.addonKey);
    await notify.notifyOwners({
      businessId: ba.businessId, type: 'BILLING_ADDON',
      title: ba.isTrial ? `Your ${addon?.name || 'trial'} trial ends ${fmtDate(ba.currentPeriodEnd)}` : `${addon?.name || 'Feature'} ends ${fmtDate(ba.currentPeriodEnd)}`,
      message: ba.isTrial ? 'Keep it by staying subscribed - an invoice is issued before the trial ends.' : 'It will switch off then. Open Billing > Premium features to keep it.',
      data: { addonKey: ba.addonKey }, eventType: 'ADDON_ENDING',
    });
  });
}

module.exports = {
  adminListCatalog, adminCreate, adminUpdate, adminSetActive, adminRemove, adminSeedStarter,
  ownerView, subscribe, cancel, resume, syncPaid,
  adminBasePlans, adminSetBasePlan, adminBusinessView, adminGrant, adminRevoke, adminSetPrice, adminGrantExisting, adminPromote, runRenewals,
};
