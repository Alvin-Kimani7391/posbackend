/**
 * Automatic customer SMS: "ready for collection", uncollected nudges, service due, warranty and insurance expiry.
 *
 * Rules that keep this safe:
 *  - OFF by default per business (each text costs SMS credits); the owner switches each alert on.
 *  - Every alert has a dedupeKey, enforced by a unique index, so reruns of the job or a double click never text twice.
 *  - Needs an approved sender ID and credits. If either is missing the alert is skipped (and the owner told once a day
 *    about credits); nothing is sent and nothing is charged.
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
};
const PLACEHOLDERS = ['name', 'shop', 'shopPhone', 'shopPhoneText', 'item', 'job', 'plate', 'balance', 'balanceText', 'date', 'dueText', 'days'];
const SAMPLE = {
  name: 'Wanjiru', shop: 'Your Shop', shopPhone: '0712345678', shopPhoneText: ' or call 0712345678', item: 'Samsung A15', job: 'RPR-000123', plate: 'KDG 123A',
  balance: '2,500', balanceText: ' Balance: KES 2,500.', date: '12 Nov', dueText: 'is due for service on 12 Nov', days: '3',
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
  };
}

function checkTemplate(label, t) {
  if (!t) return;
  const bad = [...String(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !PLACEHOLDERS.includes(k));
  if (bad.length) throw ApiError.badRequest(`${label}: unknown placeholder {${bad[0]}}. Allowed: ${PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}`, 'BAD_TEMPLATE');
  if (/[^\x00-\x7F]/.test(t)) throw ApiError.badRequest(`${label}: use plain characters only (emojis and accents make the SMS cost more)`, 'BAD_TEMPLATE');
}

async function getSettings(businessId) {
  const [b, wallet, senders] = await Promise.all([
    Business.findById(businessId).select('name phone smsAlerts featureSettings'),
    sms.getWallet(businessId),
    M.SmsSenderId.find({ businessId, status: 'active' }).distinct('senderId'),
  ]);
  if (!b) throw ApiError.notFound('Business not found');
  return { settings: effective(b), defaults: DEFAULT_TEMPLATES, placeholders: PLACEHOLDERS, approvedSenderIds: senders, credits: wallet.availableCredits, ready: senders.length > 0 && wallet.availableCredits > 0 };
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
  const key = { ready: 'ready', readyReminder: 'readyReminder', serviceDue: 'serviceDue', serviceOverdue: 'serviceOverdue', warrantyExpiring: 'warrantyExpiring', insuranceExpiring: 'insuranceExpiring' }[kind];
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
      type: 'SYSTEM_ALERT', title: 'Customer SMS alerts are paused', data: { kind: 'SMS_NO_CREDITS' },
      message: 'Your SMS credits have run out, so automatic customer texts (ready for collection, service reminders) were not sent. Top up SMS credits to resume.',
    });
  } catch (e) { console.error('[sms alerts] notice failed', e.message); }
}

/**
 * Queue one alert text. Never throws: returns { queued: true } or { skipped: REASON }.
 * `respectOptOut=false` is only for notices about the customer's own item that is waiting for them.
 */
async function enqueue(businessId, cfg, { phone, customerId, name, text, purpose, dedupeKey, refType, refId, respectOptOut = true }) {
  try {
    const to = normalizePhone(phone);
    if (!to) return { skipped: 'BAD_PHONE' };
    if (await M.SmsMessage.exists({ businessId, dedupeKey })) return { skipped: 'DUPLICATE' };
    if (respectOptOut && await Customer.exists({ businessId, phoneNormalized: to, smsOptOut: true })) return { skipped: 'OPTED_OUT' };

    const senders = await M.SmsSenderId.find({ businessId, status: 'active' }).distinct('senderId');
    if (!senders.length) return { skipped: 'NO_SENDER_ID' };
    const senderId = cfg.senderId && senders.includes(cfg.senderId) ? cfg.senderId : senders[0];

    const segments = sms.segmentsOf(text);
    await sms.getWallet(businessId);
    const wallet = await M.SmsWallet.findOneAndUpdate({ businessId, availableCredits: { $gte: segments } }, { $inc: { availableCredits: -segments } }, { new: true });
    if (!wallet) { await lowCreditsNotice(businessId); return { skipped: 'NO_CREDITS' }; }
    await M.SmsLedger.create({ businessId, type: 'CAMPAIGN_RESERVE', credits: -segments, reference: `alert:${dedupeKey}`, note: `Alert SMS (${purpose})` }).catch(() => {});

    try {
      await M.SmsMessage.create({
        businessId, customerId, name, phone: to, text, senderId, segments, status: 'queued', nextAttemptAt: nextSendTime(new Date(), cfg.quietHours),
        purpose, dedupeKey, refType, refId,
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

/** One business, all enabled reminder types. Capped so one tick cannot flood the SMS queue. */
async function runReminders(businessId, { limit = 200 } = {}) {
  const biz = await loadBusiness(businessId);
  if (!biz || biz.b.status !== 'active' || ['suspended', 'cancelled'].includes(biz.b.subscriptionStatus)) return null;
  const result = {};
  for (const [name, fn] of [['readyReminder', readyReminders], ['serviceDue', serviceReminders], ['insurance', insuranceReminders], ['warranty', warrantyReminders]]) {
    try { result[name] = await fn(biz, limit); } catch (e) { console.error(`[sms alerts] ${name} failed`, String(businessId), e.message); result[name] = { error: e.message }; }
  }
  return result;
}

/** Sent alerts for the owner's screen: what went out, to whom, and whether it was delivered. */
async function listMessages(businessId, { purpose, status, page = 1, limit = 20 }) {
  const filter = { businessId, purpose: purpose || { $type: 'string' } };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    M.SmsMessage.find(filter).select('purpose name phone text status segments error sentAt deliveredAt createdAt nextAttemptAt refType refId').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    M.SmsMessage.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

module.exports = { DEFAULT_TEMPLATES, PLACEHOLDERS, render, nextSendTime, effective, getSettings, updateSettings, preview, enqueue, onReady, runReminders, listMessages, readyAtOf };