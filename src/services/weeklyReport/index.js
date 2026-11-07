'use strict';
/**
 * weeklyReport service: who gets it, build + send, schedule, demo.
 *  - Recipients per business: active OWNER + MANAGER users with an email (the business email is used only if there are none).
 *  - A business that opted out (alertPrefs.weeklyReportEmail === false), or has no sales/stock data at all, is skipped.
 *  - Never throws for one bad business; every shop is isolated.
 */
const Business = require('../../models/Business');
const User = require('../../models/User');
const Settings = require('../../models/WeeklyReportSettings');
const { ROLES } = require('../../constants/roles');
const { sendEmail } = require('../email.service');
const { collect, localDate, zonedMidnight } = require('./data');
const { buildLowStockPdf, buildExpiryPdf } = require('./pdf');
const { build: buildEmail } = require('./email');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const slug = (s) => String(s || 'shop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'shop';

async function getSettings() {
  return Settings.findOneAndUpdate({ key: 'weekly' }, { $setOnInsert: { key: 'weekly' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
}

async function recipientsFor(businessId) {
  const [business, users] = await Promise.all([
    Business.findById(businessId).select('name email').lean(),
    User.find({ businessId, status: 'active', role: { $in: [ROLES.OWNER, ROLES.MANAGER] }, email: { $type: 'string' } }).select('name email role').lean(),
  ]);
  const seen = new Set(); const to = [];
  users.forEach((u) => { const e = String(u.email).trim().toLowerCase(); if (e && !seen.has(e)) { seen.add(e); to.push({ email: e, name: u.name }); } });
  if (!to.length && business && business.email) to.push({ email: business.email });
  return to;
}

/** Build the email + 2 PDFs for a business (no sending). */
async function buildFor(businessId, { demo = false, now } = {}) {
  const data = await collect(businessId, { now });
  const [lowPdf, expPdf] = await Promise.all([buildLowStockPdf(data), buildExpiryPdf(data)]);
  const mail = buildEmail(data, { demo });
  const stamp = data.sales.period.end;
  return {
    data, ...mail,
    attachments: [
      { name: `Low-Stock-Report-${slug(data.business.name)}-${stamp}.pdf`, content: lowPdf },
      { name: `Expiry-Report-${slug(data.business.name)}-${stamp}.pdf`, content: expPdf },
    ],
  };
}

async function sendForBusiness(businessId, { to, demo = false, force = false } = {}) {
  const biz = await Business.findById(businessId).select('name alertPrefs').lean();
  if (!biz) return { ok: false, skipped: 'not_found' };
  if (!demo && !force && biz.alertPrefs && biz.alertPrefs.weeklyReportEmail === false) return { ok: false, skipped: 'opted_out' };
  const recipients = to && to.length ? to : await recipientsFor(businessId);
  if (!recipients.length) return { ok: false, skipped: 'no_recipients' };
  const built = await buildFor(businessId, { demo });
  const d = built.data;
  if (!demo && !d.sales.hasSales && !d.lowStock.total && !d.expiry.totals.atRisk.batches && !d.expiry.totals.later.batches) return { ok: false, skipped: 'no_activity' };
  const res = await sendEmail({ to: recipients, subject: built.subject, html: built.html, text: built.text, attachments: built.attachments, tags: ['weekly-report', demo ? 'demo' : 'scheduled'] });
  return { ...res, recipients: recipients.length, business: biz.name };
}

/** Every live business. Returns { businesses, sent, skipped, failed }. */
async function runAll({ trigger = 'schedule' } = {}) {
  const cursor = Business.find({ status: 'active', subscriptionStatus: { $nin: ['suspended', 'cancelled'] } }).select('_id').lean().cursor();
  const out = { businesses: 0, sent: 0, skipped: 0, failed: 0 };
  for await (const b of cursor) {
    out.businesses += 1;
    try {
      const r = await sendForBusiness(b._id);
      if (r.ok) out.sent += 1; else if (r.skipped) out.skipped += 1; else out.failed += 1;
    } catch (e) { out.failed += 1; console.error('[weekly report] business failed', String(b._id), e.message); }
  }
  await Settings.updateOne({ key: 'weekly' }, { $set: { lastRun: { at: new Date(), trigger, ...out } } });
  return out;
}

/** The admin's "send a demo" button: real numbers of one shop, delivered ONLY to the address typed in. */
async function sendDemo({ email, businessId }) {
  let id = businessId;
  if (!id) {
    // pick the shop with the most recent sale so the demo has real content
    const Sale = require('../../models/Sale');
    const last = await Sale.findOne({ saleStatus: 'COMPLETED' }).sort({ soldAt: -1 }).select('businessId').lean();
    id = last && last.businessId;
    if (!id) { const any = await Business.findOne({ status: 'active' }).select('_id').lean(); id = any && any._id; }
  }
  if (!id) return { ok: false, error: 'No business found to build a demo from.' };
  return sendForBusiness(id, { to: [{ email }], demo: true });
}

/* ------------------------------------------------------------- scheduling */
const slotKey = (dateStr, time) => `${dateStr}T${time}`;

/**
 * Called every few minutes by the job. For each configured slot whose time has passed today (and is < 3h old, so a restart
 * catches up but a stale slot never fires late at night) and that has not run yet: claim it atomically, then send.
 */
async function tick({ now = Date.now() } = {}) {
  const s = await getSettings();
  if (!s.enabled) return { ran: false, reason: 'disabled' };
  const tz = s.timezone || 'Africa/Nairobi';
  const today = localDate(now, tz);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  for (const slot of s.slots) {
    if (slot.day !== dow) continue;
    const at = zonedMidnight(today, tz) + (Number(slot.time.slice(0, 2)) * 60 + Number(slot.time.slice(3))) * 60000;
    if (now < at || now - at > 3 * 3600000) continue;
    const key = slotKey(today, slot.time);
    const claimed = await Settings.findOneAndUpdate({ key: 'weekly', ranKeys: { $ne: key } }, { $push: { ranKeys: { $each: [key], $slice: -60 } } }, { new: true });
    if (!claimed) continue;                       // already ran (or another instance took it)
    const result = await runAll({ trigger: 'schedule' });
    return { ran: true, key, ...result };
  }
  return { ran: false };
}

function describeSlots(slots) { return slots.map((s) => `${DAYS[s.day]} ${s.time}`); }

module.exports = { getSettings, recipientsFor, buildFor, sendForBusiness, runAll, sendDemo, tick, describeSlots, DAYS };
