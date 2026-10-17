/**
 * Automatic customer SMS: "ready for collection", uncollected nudges, service due, warranty and insurance expiry.
 *
 * Rules that keep this safe:
 *  - OFF by default per business (each text costs SMS credits); the owner switches each alert on.
 *  - Every alert has a dedupeKey, enforced by a unique index, so reruns of the job or a double click never text twice.
 *  - Needs a Sender ID and credits. The shop's own approved Sender ID is used when it has one; otherwise the platform's
 *    shared default Sender ID (Admin > Alerts & SMS). If either is missing the alert is skipped (and the owner told once
 *    a day about credits); nothing is sent and nothing is charged.
 *  - Customers who opted out (Customer.smsOptOut) only get the "ready for collection" notice (it is about their own
 *    property); reminders are never sent to them.
 *  - Quiet hours (Nairobi time): texts created at night are held until morning.
 *  - Credits are reserved before the message is queued; a failed send is refunded by the queue worker.
 */
const mongoose = require('mongoose');
const Business = require('../../models/Business');
const Customer = require('../../models/Customer');
const Vehicle = require('../../models/Vehicle');
const JobCard = require('../../models/JobCard');
const RepairJob = require('../../models/RepairJob');
const SerialNumber = require('../../models/SerialNumber');
const Product = require('../../models/Product');
const Layaway = require('../../models/Layaway');
const User = require('../../models/User');
const Notification = require('../../models/Notification');
const M = require('../../models/sms.models');
const ApiError = require('../../utils/ApiError');
const { normalizePhone, toLocalPhone } = require('../../utils/phone');
const sms = require('./sms.service');

const DAY = 86400000;
const EAT_OFFSET = 3 * 3600000; // Kenya is UTC+3 all year (no DST)

const DEFAULT_TEMPLATES = {
  ready: 'Hi {name}, your {item} ({job}) is ready for collection at {shop}.{balanceText} Please carry your ID.',
  readyReminder: 'Hi {name}, reminder: your {item} ({job}) is still waiting for collection at {shop}.{balanceText}',
  serviceDue: 'Hi {name}, your {item} {dueText}. Visit {shop}{shopPhoneText} to book.',
  serviceOverdue: 'Hi {name}, your {item} is overdue for service. Visit {shop}{shopPhoneText} to book.',
  warrantyExpiring: 'Hi {name}, the warranty on your {item} ends on {date}. Bring it to {shop} for a check before then.',
  insuranceExpiring: 'Hi {name}, the insurance for {item} expires on {date}. Renew in time to stay covered. {shop}',
  layawayDue: 'Hi {name}, your layaway {job} at {shop} is due on {date}. Balance: KES {balance}. Please complete payment to collect your items.',
  layawayOverdue: 'Hi {name}, your layaway {job} at {shop} is overdue. Balance: KES {balance}. Please pay or call{shopPhoneText} to avoid cancellation.',
  lowStockDigest: 'Low stock {shop}: {low} item(s) running low and {out} out of stock. Most urgent: {items}. Open Inventory to reorder.',
  expiryDigest: 'Expiry alert {shop}: {expired} batch(es) expired and {expiring} expiring within {days} days. Soonest: {items}. Open Batches & expiry to act.',
};
const PLACEHOLDERS = ['name', 'shop', 'shopPhone', 'shopPhoneText', 'item', 'job', 'plate', 'balance', 'balanceText', 'date', 'dueText', 'days', 'expired', 'expiring', 'items', 'low', 'out'];
const SAMPLE = {
  name: 'Wanjiru', shop: 'Your Shop', shopPhone: '0712345678', shopPhoneText: ' or call 0712345678', item: 'Samsung A15', job: 'RPR-000123', plate: 'KDG 123A',
  balance: '2,500', balanceText: ' Balance: KES 2,500.', date: '12 Nov', dueText: 'is due for service on 12 Nov', days: '3',
  expired: '2', expiring: '5', items: 'Amoxicillin 500mg (12 Nov), Panadol (20 Nov)', low: '6', out: '2',
};

const dateText = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' });
const kes = (cents) => Math.round(cents / 100).toLocaleString('en-KE');

function render(tpl, ctx) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined && ctx[k] !== null ? String(ctx[k]) : '')).replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
}

/** The earliest moment a message may go out given quiet hours (Nairobi time). */
function nextSendTime(now, quiet) {
  if (!quiet || quiet.enabled === false) return now;
  const start = quiet.startHour ?? 8; const end = quiet.endHour ?? 20;
  const eat = new Date(now.getTime() + EAT_OFFSET);
  const h = eat.getUTCHours();
  if (h >= start && h < end) return now;
  const target = new Date(eat);
  target.setUTCHours(start, 0, 0, 0);
  if (h >= end) target.setUTCDate(target.getUTCDate() + 1);
  return new Date(target.getTime() - EAT_OFFSET);
}

/* ---------------------------------- settings ---------------------------------- */
function effective(b) {
  const a = (b && b.smsAlerts && (b.smsAlerts.toObject ? b.smsAlerts.toObject() : b.smsAlerts)) || {};
  return {
    senderId: a.senderId || '',
    quietHours: { enabled: a.quietHours?.enabled !== false, startHour: a.quietHours?.startHour ?? 8, endHour: a.quietHours?.endHour ?? 20 },
    ready: { enabled: !!a.ready?.enabled, template: a.ready?.template || '' },
    readyReminder: { enabled: !!a.readyReminder?.enabled, afterDays: a.readyReminder?.afterDays?.length ? a.readyReminder.afterDays : [3, 7, 14], template: a.readyReminder?.template || '' },
    serviceDue: { enabled: !!a.serviceDue?.enabled, daysBefore: a.serviceDue?.daysBefore ?? 7, kmWindow: a.serviceDue?.kmWindow ?? 500, template: a.serviceDue?.template || '', overdueTemplate: a.serviceDue?.overdueTemplate || '' },
    warrantyExpiring: { enabled: !!a.warrantyExpiring?.enabled, daysBefore: a.warrantyExpiring?.daysBefore ?? 14, template: a.warrantyExpiring?.template || '' },
    insuranceExpiring: { enabled: !!a.insuranceExpiring?.enabled, daysBefore: a.insuranceExpiring?.daysBefore ?? 14, template: a.insuranceExpiring?.template || '' },
    layawayDue: { enabled: !!a.layawayDue?.enabled, daysBefore: a.layawayDue?.daysBefore ?? 3, template: a.layawayDue?.template || '', overdueTemplate: a.layawayDue?.overdueTemplate || '' },
    lowStockDigest: { enabled: !!a.lowStockDigest?.enabled, frequency: a.lowStockDigest?.frequency === 'daily' ? 'daily' : 'weekly', includeOutOfStock: a.lowStockDigest?.includeOutOfStock !== false, template: a.lowStockDigest?.template || '' },
    expiryDigest: { enabled: !!a.expiryDigest?.enabled, frequency: a.expiryDigest?.frequency === 'daily' ? 'daily' : 'weekly', daysBefore: a.expiryDigest?.daysBefore ?? 30, template: a.expiryDigest?.template || '' },
  };
}

function checkTemplate(label, t) {
  if (!t) return;
  const bad = [...String(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !PLACEHOLDERS.includes(k));
  if (bad.length) throw ApiError.badRequest(`${label}: unknown placeholder {${bad[0]}}. Allowed: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`, 'BAD_TEMPLATE');
  if (/[^\x00-\x7F]/.test(t)) throw ApiError.badRequest(`${label}: use plain characters only (emojis and accents make the SMS cost more)`, 'BAD_TEMPLATE');
}

async function getSettings(businessId) {
  const [b, wallet, senders, def] = await Promise.all([
    Business.findById(businessId).select('name phone smsAlerts featureSettings'),
    sms.getWallet(businessId),
    M.SmsSenderId.find({ businessId, status: 'active' }).distinct('senderId'),
    sms.getDefaultSender(),
  ]);
  if (!b) throw ApiError.notFound('Business not found');
  // Why texts would not go out right now (empty list = all good). The screen shows these in plain words.
  const blockers = [];
  if (!def.alertsEnabled) blockers.push('ALERTS_PAUSED');
  if (!senders.length && !def.enabled) blockers.push('NO_SENDER_ID');
  if (!(wallet.availableCredits > 0)) blockers.push('NO_CREDITS');
  return {
    settings: effective(b), defaults: DEFAULT_TEMPLATES, placeholders: PLACEHOLDERS, approvedSenderIds: senders,
    defaultSenderId: !senders.length && def.enabled ? def.senderId : '', // shown to the owner only when it is the one in use
    credits: wallet.availableCredits, ready: blockers.length === 0, blockers,
  };
}

async function updateSettings(businessId, patch) {
  const b = await Business.findById(businessId);
  if (!b) throw ApiError.notFound('Business not found');
  if (patch.senderId) {
    const ok = await M.SmsSenderId.exists({ businessId, senderId: patch.senderId, status: 'active' });
    if (!ok) throw ApiError.badRequest('That Sender ID is not approved for your business', 'SENDER_NOT_APPROVED');
  }
  const next = effective(b);
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object') next[k] = { ...next[k], ...v };
    else if (v !== undefined) next[k] = v;
  }
  if (next.quietHours.endHour <= next.quietHours.startHour) throw ApiError.badRequest('Quiet hours: the end hour must be after the start hour', 'BAD_QUIET_HOURS');
  for (const [k, section] of Object.entries(next)) if (section && typeof section === 'object') for (const f of ['template', 'overdueTemplate']) checkTemplate(`${k}.${f}`, section[f]);
  next.readyReminder.afterDays = [...new Set(next.readyReminder.afterDays.map(Number))].filter((n) => n >= 1 && n <= 90).sort((a, c) => a - c).slice(0, 5);
  if (!next.readyReminder.afterDays.length) next.readyReminder.afterDays = [3, 7, 14];
  b.smsAlerts = next;
  await b.save();
  return getSettings(businessId);
}

/** What a template will look like (sample data) and how many credits one text costs. */
function preview(kind, template) {
  const key = { ready: 'ready', readyReminder: 'readyReminder', layawayDue: 'layawayDue', layawayOverdue: 'layawayOverdue', serviceDue: 'serviceDue', serviceOverdue: 'serviceOverdue', warrantyExpiring: 'warrantyExpiring', insuranceExpiring: 'insuranceExpiring', expiryDigest: 'expiryDigest', lowStockDigest: 'lowStockDigest' }[kind];
  if (!key) throw ApiError.badRequest('Unknown alert type', 'BAD_KIND');
  checkTemplate('template', template);
  const text = render(template || DEFAULT_TEMPLATES[key], SAMPLE);
  return { text, characters: [...text].length, credits: sms.segmentsOf(text) };
}

/* ---------------------------------- sending ---------------------------------- */
async function lowCreditsNotice(businessId) {
  const since = new Date(Date.now() - DAY);
  const recent = await Notification.exists({ businessId, type: 'SYSTEM_ALERT', 'data.kind': 'SMS_NO_CREDITS', createdAt: { $gte: since } });
  if (recent) return;
  try {
    await require('../notification.service').notifyManagement(businessId, {
      type: 'SYSTEM_ALERT', title: 'SMS alerts are paused', data: { kind: 'SMS_NO_CREDITS', link: 'sms.html' },
      message: 'You have no SMS credits left, so automatic texts (low stock, expiry, customer reminders) were not sent. Top up SMS credits to resume.',
    });
  } catch (e) { console.error('[sms alerts] notice failed', e.message); }
}

/**
 * Queue one alert text. Never throws: returns { queued: true } or { skipped: REASON }.
 * `respectOptOut=false` is only for notices about the customer's own item that is waiting for them.
 */
async function enqueue(businessId, cfg, { phone, customerId, name, text, purpose, dedupeKey, refType, refId, respectOptOut = true, bypassQuiet = false }) {
  try {
    const gate = await sms.getDefaultSender();
    if (!gate.alertsEnabled) return { skipped: 'ALERTS_PAUSED' };
    const to = normalizePhone(phone);
    if (!to) return { skipped: 'BAD_PHONE' };
    if (await M.SmsMessage.exists({ businessId, dedupeKey })) return { skipped: 'DUPLICATE' };
    if (respectOptOut && await Customer.exists({ businessId, phoneNormalized: to, smsOptOut: true })) return { skipped: 'OPTED_OUT' };

    const sender = await sms.resolveSender(businessId, cfg.senderId);
    if (!sender.senderId) return { skipped: 'NO_SENDER_ID' };
    const senderId = sender.senderId;

    const segments = sms.segmentsOf(text);
    await sms.getWallet(businessId);
    const wallet = await M.SmsWallet.findOneAndUpdate({ businessId, availableCredits: { $gte: segments } }, { $inc: { availableCredits: -segments } }, { new: true });
    if (!wallet) { await lowCreditsNotice(businessId); return { skipped: 'NO_CREDITS' }; }
    await M.SmsLedger.create({ businessId, type: 'CAMPAIGN_RESERVE', credits: -segments, reference: `alert:${dedupeKey}`, note: `Alert SMS (${purpose})` }).catch(() => {});

    try {
      await M.SmsMessage.create({
        businessId, customerId, name, phone: to, text, senderId, segments, status: 'queued', nextAttemptAt: bypassQuiet ? new Date() : nextSendTime(new Date(), cfg.quietHours),
        purpose, dedupeKey, refType, refId, senderSource: sender.source,
      });
    } catch (e) {
      await sms.creditWallet(businessId, segments, { type: 'CAMPAIGN_REFUND', reference: `alert-undo:${dedupeKey}:${Date.now()}`, note: 'Alert not queued' });
      if (e.code === 11000) return { skipped: 'DUPLICATE' };
      throw e;
    }
    return { queued: true, segments };
  } catch (e) {
    console.error('[sms alerts] enqueue failed', purpose, e.message);
    return { skipped: 'ERROR' };
  }
}

async function loadBusiness(businessId) {
  const b = await Business.findById(businessId).select('name phone smsAlerts featureSettings status subscriptionStatus');
  if (!b) return null;
  return { b, cfg: effective(b), shop: b.name, shopPhone: b.phone ? toLocalPhone(normalizePhone(b.phone)) || b.phone : '' };
}

function ctxBase(biz) {
  return { shop: biz.shop, shopPhone: biz.shopPhone, shopPhoneText: biz.shopPhone ? ` or call ${biz.shopPhone}` : '' };
}

/* ------------------------------ ready for collection ------------------------------ */
const readyAtOf = (job) => {
  const h = [...(job.history || [])].reverse().find((x) => x.status === 'READY');
  return h?.at || job.updatedAt;
};
const itemOf = (kind, job) => (kind === 'repair'
  ? [job.device?.brand, job.device?.model].filter(Boolean).join(' ') || 'device'
  : [job.plate, job.vehicleLabel].filter(Boolean).join(' ') || 'vehicle');
const jobNo = (job) => job.jobNumber;
const balanceCtx = (job) => (job.balance > 0 ? { balance: kes(job.balance), balanceText: ` Balance: KES ${kes(job.balance)}.` } : { balance: '0', balanceText: '' });

/**
 * A repair job / job card has just become READY: text the customer. Called after the status change is committed;
 * never throws, never blocks the workflow. `manual` = staff pressed "send again" (limited to once an hour).
 */
async function onReady(kind, jobOrId, { businessId: bid, manual = false } = {}) {
  try {
    const Model = kind === 'repair' ? RepairJob : JobCard;
    const job = jobOrId && jobOrId._id ? jobOrId : await Model.findById(jobOrId);
    if (!job) return { skipped: 'NOT_FOUND' };
    const businessId = bid || job.businessId;
    const biz = await loadBusiness(businessId);
    if (!biz) return { skipped: 'NO_BUSINESS' };
    if (!biz.cfg.ready.enabled) return { skipped: 'DISABLED' };
    if (job.status !== 'READY') return { skipped: 'NOT_READY' };
    const text = render(biz.cfg.ready.template || DEFAULT_TEMPLATES.ready, { ...ctxBase(biz), name: (job.customerName || '').split(/\s+/)[0] || 'Customer', item: itemOf(kind, job), job: jobNo(job), plate: job.plate || '', ...balanceCtx(job) });
    const hour = new Date().toISOString().slice(0, 13);
    return await enqueue(businessId, biz.cfg, {
      phone: job.customerPhone, customerId: job.customerId, name: job.customerName, text, purpose: 'READY',
      dedupeKey: manual ? `ready-manual:${kind}:${job._id}:${hour}` : `ready:${kind}:${job._id}`, refType: kind === 'repair' ? 'RepairJob' : 'JobCard', refId: job._id, respectOptOut: false,
    });
  } catch (e) { console.error('[sms alerts] onReady failed', e.message); return { skipped: 'ERROR' }; }
}

/** Nudge customers whose finished item is still here: one text, at the highest step (3 / 7 / 14 days) reached. */
async function readyReminders(biz, limit) {
  const { cfg } = biz; const businessId = biz.b._id; const out = { queued: 0, skipped: 0 };
  if (!cfg.readyReminder.enabled) return out;
  const steps = [...cfg.readyReminder.afterDays].sort((a, c) => c - a);
  const sources = [];
  if (biz.b.featureSettings?.repairManagement) sources.push(['repair', RepairJob]);
  if (biz.b.featureSettings?.jobCards) sources.push(['jobcard', JobCard]);
  for (const [kind, Model] of sources) {
    const jobs = await Model.find({ businessId, status: 'READY' }).limit(1000);
    for (const job of jobs) {
      if (out.queued >= limit) return out;
      const days = Math.floor((Date.now() - new Date(readyAtOf(job)).getTime()) / DAY);
      const step = steps.find((d) => days >= d);
      if (!step) continue;
      const text = render(cfg.readyReminder.template || DEFAULT_TEMPLATES.readyReminder, { ...ctxBase(biz), name: (job.customerName || '').split(/\s+/)[0] || 'Customer', item: itemOf(kind, job), job: jobNo(job), plate: job.plate || '', days: String(days), ...balanceCtx(job) });
      const r = await enqueue(businessId, cfg, { phone: job.customerPhone, customerId: job.customerId, name: job.customerName, text, purpose: 'READY_REMINDER', dedupeKey: `ready-reminder:${kind}:${job._id}:${step}`, refType: kind === 'repair' ? 'RepairJob' : 'JobCard', refId: job._id });
      if (r.queued) out.queued += 1; else if (r.skipped !== 'DUPLICATE') out.skipped += 1;
    }
  }
  return out;
}

/* ------------------------------ vehicle reminders ------------------------------ */
async function serviceReminders(biz, limit) {
  const { cfg } = biz; const businessId = biz.b._id; const out = { queued: 0, skipped: 0 };
  if (!cfg.serviceDue.enabled || !biz.b.featureSettings?.vehicleManagement) return out;
  const now = Date.now(); const horizon = new Date(now + cfg.serviceDue.daysBefore * DAY);
  const inGarage = new Set((await JobCard.distinct('vehicleId', { businessId, status: { $nin: ['COLLECTED', 'CANCELLED'] } })).map(String));
  const vehicles = await Vehicle.find({
    businessId, status: 'active', ownerPhone: { $type: 'string' },
    $or: [{ nextServiceDate: { $lte: horizon, $gte: new Date(now - 14 * DAY) } }, { nextServiceKm: { $gt: 0 } }],
  }).limit(2000);

  for (const v of vehicles) {
    if (out.queued >= limit) break;
    if (inGarage.has(String(v._id))) continue; // it is here now
    const inWindow = v.nextServiceDate && v.nextServiceDate.getTime() >= now - 14 * DAY && v.nextServiceDate <= horizon; // older than 2 weeks overdue: stop nagging
    const dateDue = !!inWindow;
    const overdue = !!inWindow && v.nextServiceDate.getTime() < now;
    const kmDue = v.nextServiceKm > 0 && v.odometerKm >= v.nextServiceKm - cfg.serviceDue.kmWindow;
    if (!dateDue && !kmDue) continue;
    const cycle = `${v.nextServiceKm || ''}:${v.nextServiceDate ? v.nextServiceDate.toISOString().slice(0, 10) : ''}`;
    const item = [v.plateDisplay || v.plate, [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' ');
    const base = { ...ctxBase(biz), name: (v.ownerName || '').split(/\s+/)[0] || 'Customer', item, plate: v.plateDisplay || v.plate };
    const isOverdue = overdue || (kmDue && v.odometerKm > v.nextServiceKm);
    let text; let purpose; let stage;
    if (isOverdue) {
      stage = 'over'; purpose = 'SERVICE_OVERDUE';
      text = render(cfg.serviceDue.overdueTemplate || DEFAULT_TEMPLATES.serviceOverdue, base);
    } else {
      stage = 'due'; purpose = 'SERVICE_DUE';
      const dueText = dateDue && v.nextServiceDate
        ? `is due for service on ${dateText(v.nextServiceDate)}`
        : `is nearly due for service (${Math.round(v.nextServiceKm).toLocaleString('en-KE')} km)`;
      text = render(cfg.serviceDue.template || DEFAULT_TEMPLATES.serviceDue, { ...base, date: v.nextServiceDate ? dateText(v.nextServiceDate) : '', dueText });
    }
    const r = await enqueue(businessId, cfg, { phone: v.ownerPhone, customerId: v.customerId, name: v.ownerName, text, purpose, dedupeKey: `service:${stage}:${v._id}:${cycle}`, refType: 'Vehicle', refId: v._id });
    if (r.queued) out.queued += 1; else if (r.skipped !== 'DUPLICATE') out.skipped += 1;
  }
  return out;
}

async function insuranceReminders(biz, limit) {
  const { cfg } = biz; const businessId = biz.b._id; const out = { queued: 0, skipped: 0 };
  if (!cfg.insuranceExpiring.enabled || !biz.b.featureSettings?.vehicleManagement) return out;
  const now = new Date(); const horizon = new Date(now.getTime() + cfg.insuranceExpiring.daysBefore * DAY);
  const vehicles = await Vehicle.find({ businessId, status: 'active', ownerPhone: { $type: 'string' }, insuranceExpiry: { $gte: now, $lte: horizon } }).limit(2000);
  for (const v of vehicles) {
    if (out.queued >= limit) break;
    const item = [v.plateDisplay || v.plate, [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' ');
    const text = render(cfg.insuranceExpiring.template || DEFAULT_TEMPLATES.insuranceExpiring, { ...ctxBase(biz), name: (v.ownerName || '').split(/\s+/)[0] || 'Customer', item, plate: v.plateDisplay || v.plate, date: dateText(v.insuranceExpiry) });
    const r = await enqueue(businessId, cfg, { phone: v.ownerPhone, customerId: v.customerId, name: v.ownerName, text, purpose: 'INSURANCE_EXPIRING', dedupeKey: `insurance:${v._id}:${v.insuranceExpiry.toISOString().slice(0, 10)}`, refType: 'Vehicle', refId: v._id });
    if (r.queued) out.queued += 1; else if (r.skipped !== 'DUPLICATE') out.skipped += 1;
  }
  return out;
}

/* ------------------------------ layaway ------------------------------ */
/** Remind customers with an unpaid layaway: before the due date, and (for 'graceDays' after) when it is overdue. */
async function layawayReminders(biz, limit) {
  const { cfg } = biz; const businessId = biz.b._id; const out = { queued: 0, skipped: 0 };
  if (!cfg.layawayDue.enabled || !biz.b.featureSettings?.layaway) return out;
  const now = Date.now(); const horizon = new Date(now + cfg.layawayDue.daysBefore * DAY);
  const rows = await Layaway.find({ businessId, status: 'ACTIVE', dueDate: { $lte: horizon } }).limit(1000);
  for (const l of rows) {
    if (out.queued >= limit) break;
    if (l.balance <= 0) continue; // fully paid: waiting for the customer to collect, not a payment reminder
    const overdue = l.dueDate.getTime() < now;
    if (overdue && now - l.dueDate.getTime() > (l.terms?.graceDays ?? 7) * DAY) continue; // past the grace window: the manager decides
    const ctx = { ...ctxBase(biz), name: (l.customerName || '').split(/\s+/)[0] || 'Customer', job: l.number, date: dateText(l.dueDate), balance: kes(l.balance), item: l.number };
    const text = overdue ? render(cfg.layawayDue.overdueTemplate || DEFAULT_TEMPLATES.layawayOverdue, ctx) : render(cfg.layawayDue.template || DEFAULT_TEMPLATES.layawayDue, ctx);
    const r = await enqueue(businessId, cfg, {
      phone: l.customerPhone, customerId: l.customerId, name: l.customerName, text, purpose: overdue ? 'LAYAWAY_OVERDUE' : 'LAYAWAY_DUE',
      dedupeKey: `layaway:${overdue ? 'over' : 'due'}:${l._id}:${l.dueDate.toISOString().slice(0, 10)}`, refType: 'Layaway', refId: l._id,
    });
    if (r.queued) out.queued += 1; else if (r.skipped !== 'DUPLICATE') out.skipped += 1;
  }
  return out;
}

/* ------------------------------ electronics warranty ------------------------------ */
async function warrantyReminders(biz, limit) {
  const { cfg } = biz; const businessId = biz.b._id; const out = { queued: 0, skipped: 0 };
  if (!cfg.warrantyExpiring.enabled || !biz.b.featureSettings?.warrantyManagement) return out;
  const now = new Date(); const horizon = new Date(now.getTime() + cfg.warrantyExpiring.daysBefore * DAY);
  const units = await SerialNumber.find({ businessId, status: 'sold', customerId: { $type: 'objectId' }, warrantyEnd: { $gte: now, $lte: horizon } }).limit(2000);
  if (!units.length) return out;
  const [customers, products] = await Promise.all([
    Customer.find({ businessId, _id: { $in: units.map((u) => u.customerId) } }).select('name phone').lean(),
    Product.find({ businessId, _id: { $in: units.map((u) => u.productId) } }).select('name').lean(),
  ]);
  const cById = new Map(customers.map((c) => [String(c._id), c])); const pById = new Map(products.map((p) => [String(p._id), p]));
  for (const u of units) {
    if (out.queued >= limit) break;
    const c = cById.get(String(u.customerId)); if (!c?.phone) continue;
    const text = render(cfg.warrantyExpiring.template || DEFAULT_TEMPLATES.warrantyExpiring, { ...ctxBase(biz), name: (c.name || '').split(/\s+/)[0] || 'Customer', item: pById.get(String(u.productId))?.name || 'device', date: dateText(u.warrantyEnd) });
    const r = await enqueue(businessId, cfg, { phone: c.phone, customerId: c._id, name: c.name, text, purpose: 'WARRANTY_EXPIRING', dedupeKey: `warranty:${u._id}:${u.warrantyEnd.toISOString().slice(0, 10)}`, refType: 'SerialNumber', refId: u._id });
    if (r.queued) out.queued += 1; else if (r.skipped !== 'DUPLICATE') out.skipped += 1;
  }
  return out;
}

/* ------------------------------ owner phone numbers + test text ------------------------------ */
/** Active owners with a usable mobile number. Falls back to the business phone when no owner phone is valid. */
async function ownersToText(businessId) {
  const owners = await User.find({ businessId, role: 'OWNER', status: 'active' }).select('_id name phone').lean();
  const good = owners.filter((o) => normalizePhone(o.phone));
  if (good.length) return good;
  const b = await Business.findById(businessId).select('name phone').lean();
  if (b && normalizePhone(b.phone)) return [{ _id: businessId, name: b.name, phone: b.phone }];
  return [];
}

const maskPhone = (p) => { const l = toLocalPhone(normalizePhone(p)); return l ? `${l.slice(0, 4)} *** ${l.slice(-3)}` : ''; };

/** The owner presses "Send me a test text": proves the whole chain (sender, credits, TalkSasa, phone) works. Costs 1 credit. */
async function sendOwnerTest(businessId, userId) {
  const user = await User.findOne({ _id: userId, businessId }).select('name phone').lean();
  if (!user || !normalizePhone(user.phone)) return { skipped: 'BAD_PHONE' };
  const biz = await loadBusiness(businessId);
  if (!biz) return { skipped: 'NO_BUSINESS' };
  const since = new Date(Date.now() - 3600000);
  if (await M.SmsMessage.countDocuments({ businessId, purpose: 'OWNER_TEST', createdAt: { $gte: since } }) >= 5) return { skipped: 'RATE_LIMIT' };
  const text = render('Test from {shop}: your SMS alerts are working. Low stock and expiry texts will come to this number.', ctxBase(biz));
  const r = await enqueue(businessId, biz.cfg, {
    phone: user.phone, name: user.name, text, purpose: 'OWNER_TEST', dedupeKey: `test:${userId}:${Date.now()}`,
    refType: 'Business', refId: businessId, respectOptOut: false, bypassQuiet: true,
  });
  return r.queued ? { ...r, to: maskPhone(user.phone) } : r;
}

/* ------------------------------ expiry digest (staff alert) ------------------------------ */
const asciiOnly = (s) => String(s || '').replace(/[^\x20-\x7E]/g, '').trim();

/**
 * Text the shop OWNER(S) a short expiry summary. `summary` comes from batch.service#expirySummary (computed for
 * cfg.expiryDigest.daysBefore). Sent at most once per day (daily) or per week (weekly) per owner, only when something
 * is expired or expiring. Never throws. Returns { queued, skipped }.
 */
async function sendExpiryDigest(businessId, summary) {
  const out = { queued: 0, skipped: 0 };
  try {
    const biz = await loadBusiness(businessId);
    if (!biz || !biz.cfg.expiryDigest.enabled) return { ...out, reason: 'DISABLED' };
    const d = biz.cfg.expiryDigest;
    const expired = summary.expired?.batches || 0;
    const expiring = (summary.critical?.batches || 0) + (summary.warning?.batches || 0);
    if (!expired && !expiring) return { ...out, reason: 'NOTHING' };

    const eatNow = new Date(Date.now() + EAT_OFFSET);
    const ymd = eatNow.toISOString().slice(0, 10);
    const monday = new Date(eatNow); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const periodKey = d.frequency === 'daily' ? ymd : `wk-${monday.toISOString().slice(0, 10)}`;

    const items = (summary.top || []).slice(0, 3).map((t) => `${asciiOnly(t.name).slice(0, 22)} (${new Date(t.expiryDate).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', timeZone: 'UTC' })})`).join(', ') || '-';
    const text = render(d.template || DEFAULT_TEMPLATES.expiryDigest, { ...ctxBase(biz), expired, expiring, days: d.daysBefore, items });

    const owners = await ownersToText(businessId);
    if (!owners.length) out.reason = 'NO_OWNER';
    for (const o of owners) {
      const r = await enqueue(businessId, biz.cfg, {
        phone: o.phone, name: o.name, text, purpose: 'EXPIRY_DIGEST', dedupeKey: `expiry:${businessId}:${periodKey}:${o._id}`,
        refType: 'Business', refId: businessId, respectOptOut: false,
      });
      if (r.queued) out.queued += 1; else { out.skipped += 1; out.reason = r.skipped; }
    }
  } catch (e) { console.error('[sms alerts] expiry digest failed', String(businessId), e.message); }
  return out;
}

/* ------------------------------ low stock digest (staff alert) ------------------------------ */
/**
 * Text the shop OWNER(S) which products are running low / out of stock. Opt-in; every text uses SMS credits
 * (same wallet, sender ID, quiet hours and dedupe rules as the other alerts). `summary` comes from
 * lowStockAlerts.service#lowStockSummary. `manual` = the owner pressed "Send now" (limited to once an hour).
 */
async function sendLowStockDigest(businessId, summary, { manual = false } = {}) {
  const out = { queued: 0, skipped: 0 };
  try {
    const biz = await loadBusiness(businessId);
    if (!biz || !biz.cfg.lowStockDigest.enabled) return { ...out, skipped: 0, reason: 'DISABLED' };
    const d = biz.cfg.lowStockDigest;
    const low = summary.low || 0; const outCount = d.includeOutOfStock ? (summary.out || 0) : 0;
    if (!low && !outCount) return { ...out, reason: 'NOTHING' };

    const eatNow = new Date(Date.now() + EAT_OFFSET);
    const ymd = eatNow.toISOString().slice(0, 10);
    const monday = new Date(eatNow); monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const periodKey = manual ? `now-${eatNow.toISOString().slice(0, 13)}` : d.frequency === 'daily' ? ymd : `wk-${monday.toISOString().slice(0, 10)}`;

    const pool = (summary.top || []).filter((t) => d.includeOutOfStock || t.quantity > 0).slice(0, 3);
    const items = pool.map((t) => `${asciiOnly(t.name).slice(0, 20)} (${t.quantity})`).join(', ') || '-';
    const text = render(d.template || DEFAULT_TEMPLATES.lowStockDigest, { ...ctxBase(biz), low, out: outCount, items });

    const owners = await ownersToText(businessId);
    if (!owners.length) out.reason = 'NO_OWNER';
    for (const o of owners) {
      const r = await enqueue(businessId, biz.cfg, {
        phone: o.phone, name: o.name, text, purpose: 'LOW_STOCK_DIGEST', dedupeKey: `lowstock:${businessId}:${periodKey}:${o._id}`,
        refType: 'Business', refId: businessId, respectOptOut: false, bypassQuiet: manual, // "Send now" must not wait for morning
      });
      if (r.queued) out.queued += 1; else { out.skipped += 1; out.reason = r.skipped; }
    }
  } catch (e) { console.error('[sms alerts] low stock digest failed', String(businessId), e.message); }
  return out;
}

/** One business, all enabled reminder types. Capped so one tick cannot flood the SMS queue. */
async function runReminders(businessId, { limit = 200 } = {}) {
  const biz = await loadBusiness(businessId);
  if (!biz || biz.b.status !== 'active' || ['suspended', 'cancelled'].includes(biz.b.subscriptionStatus)) return null;
  const result = {};
  for (const [name, fn] of [['readyReminder', readyReminders], ['serviceDue', serviceReminders], ['insurance', insuranceReminders], ['warranty', warrantyReminders], ['layaway', layawayReminders]]) {
    try { result[name] = await fn(biz, limit); } catch (e) { console.error(`[sms alerts] ${name} failed`, String(businessId), e.message); result[name] = { error: e.message }; }
  }
  return result;
}

/** Sent alerts for the owner's screen: what went out, to whom, and whether it was delivered. */
async function listMessages(businessId, { purpose, status, page = 1, limit = 20 }) {
  const filter = { businessId, purpose: purpose || { $type: 'string' } };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    M.SmsMessage.find(filter).select('purpose name phone text status segments error sentAt deliveredAt createdAt nextAttemptAt refType refId senderId senderSource').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    M.SmsMessage.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

module.exports = { DEFAULT_TEMPLATES, PLACEHOLDERS, render, nextSendTime, effective, getSettings, updateSettings, preview, enqueue, onReady, runReminders, listMessages, readyAtOf, sendExpiryDigest, sendLowStockDigest, sendOwnerTest, ownersToText };