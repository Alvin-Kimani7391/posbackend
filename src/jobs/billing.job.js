/**
 * Billing cycle (every 5 min). Everything here is idempotent: unique invoice index, atomic reminder claims,
 * atomic payment settlement - so overlapping runs or several app instances can't double-bill or double-email.
 */
const Subscription = require('../models/Subscription');
const Invoice = require('../models/Invoice');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const { addDays, DAY } = require('../utils/billingDates');
const { LIMITS } = require('../constants/billing');
const settingsSvc = require('../services/billing.settings');
const engine = require('../services/billing.service');
const pay = require('../services/billing.payment.service');
const notify = require('../services/billing.notify');

const INTERVAL_MS = 5 * 60 * 1000;
let running = false;

const safe = async (label, fn) => { try { return await fn(); } catch (err) { console.error(`[billing job] ${label} failed:`, err.message); return null; } };

async function claimInvoiceKey(invId, key, marks) {
  const r = await Invoice.updateOne({ _id: invId, reminderKeys: { $ne: key } }, { $addToSet: { reminderKeys: { $each: marks } } });
  return r.modifiedCount === 1;
}

async function processReminders(sub, settings, now) {
  const invoices = await Invoice.find({ subscriptionId: sub._id, status: { $in: ['PENDING', 'PARTIAL'] } }).sort({ dueDate: 1 });
  const before = [...(settings.reminders?.beforeDueDays || [])].sort((a, b) => a - b);
  const over = [...(settings.reminders?.overdueDays || [])].sort((a, b) => a - b);
  const graceDays = sub.graceDaysOverride ?? settings.enforcement?.graceDays ?? 7;
  const exempt = sub.lockExemptUntil && sub.lockExemptUntil > now;
  const canLock = settings.enforcement?.autoSuspendEnabled !== false && !exempt && !sub.lock?.active;
  let firstOverdue = true;

  for (const inv of invoices) {
    const ms = inv.dueDate - now;
    let key = null; let marks = []; const ctx = {};

    if (ms > 0) {
      const daysUntilDue = Math.ceil(ms / DAY);
      const j = before.find((d) => daysUntilDue <= d);
      if (j != null) { key = `before_${j}`; marks = before.filter((d) => d >= j).map((d) => `before_${d}`); }
      ctx.daysUntilDue = daysUntilDue;
    } else {
      const daysOverdue = Math.floor(-ms / DAY);
      const k = [...over].reverse().find((d) => daysOverdue >= d);
      if (k != null) { key = `overdue_${k}`; marks = [...over.filter((d) => d <= k).map((d) => `overdue_${d}`), 'due_now']; }
      ctx.daysOverdue = daysOverdue;
      const lockAt = addDays(inv.dueDate, graceDays);
      ctx.lockAt = canLock ? lockAt : null;
      if (firstOverdue && canLock && lockAt > now && lockAt - now <= DAY && !inv.reminderKeys.includes('lock_warning')) {
        key = 'lock_warning'; marks = ['lock_warning']; // priority: final warning inside 24h of the lock
      }
      firstOverdue = false;
    }

    if (key && (await claimInvoiceKey(inv._id, key, marks))) await notify.reminder(inv, key, ctx);
  }
}

async function processTrials(settings, now) {
  const days = [...(settings.reminders?.trialEndingDays || [])].sort((a, b) => a - b);
  if (!days.length) return;
  const subs = await Subscription.find({ status: 'TRIALING', phaseType: 'TRIAL', phaseEndsAt: { $gt: now, $lte: addDays(now, Math.max(...days)) } });
  for (const sub of subs) {
    const left = Math.ceil((sub.phaseEndsAt - now) / DAY);
    const d = days.find((x) => left <= x);
    if (d != null && (await engine.claimSubKey(sub._id, `trial_${d}_${sub.phaseEndsAt.getTime()}`))) await notify.trialEnding(sub, left);
  }
}

async function runCycle({ now = new Date(), force = false } = {}) {
  if (running && !force) return { skipped: 'already_running' };
  running = true;
  try {
    const settings = await settingsSvc.get({ fresh: true });

    // Payment safety nets run even when billing is "off" so no money is ever left in limbo.
    await safe('stk recheck', async () => {
      const stale = await SubscriptionPayment.find({
        method: 'STK',
        $or: [
          { status: 'PENDING', createdAt: { $lt: new Date(Date.now() - 60 * 1000) } },
          { status: 'FAILED', failureType: 'timeout', createdAt: { $gte: new Date(Date.now() - LIMITS.LATE_SUCCESS_WINDOW_MS) }, $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } }] },
        ],
      }).limit(100);
      for (const p of stale) await safe(`verify ${p.reference}`, () => pay.verifyStk(p, { force: true }));
    });
    await safe('unallocated payments', async () => {
      const stuck = await SubscriptionPayment.find({ status: 'SUCCESS', allocatedAt: null, updatedAt: { $lt: new Date(Date.now() - 30 * 1000) } }).limit(100);
      for (const p of stuck) await safe(`allocate ${p.reference}`, () => engine.allocatePayment(p._id));
    });

    if (!settings.billingEnabled) return { skipped: 'billing_disabled' };

    const due = await Subscription.find({ status: { $ne: 'CANCELLED' }, nextActionAt: { $ne: null, $lte: now } }).select('_id').limit(500);
    for (const s of due) await safe(`advance ${s._id}`, async () => { await engine.advanceSubscription(s._id, now); await engine.reconcile(s._id, { now }); });

    const owing = await Subscription.find({ status: { $ne: 'CANCELLED' }, openBalanceCents: { $gt: 0 } }).limit(1000);
    for (const s of owing) {
      await safe(`reconcile ${s._id}`, async () => {
        const fresh = await engine.reconcile(s._id, { now });
        await processReminders(fresh, settings, now);
      });
    }

    await safe('trial reminders', () => processTrials(settings, now));
    return { advanced: due.length, reviewed: owing.length };
  } finally {
    running = false;
  }
}

/** Call once from server.js after Mongo connects. Use your existing scheduler instead if you prefer (mpesaReconcile style). */
function start() {
  safe('seed default plan', () => engine.ensureDefaultPlan());
  setInterval(() => { runCycle().catch((e) => console.error('[billing job]', e.message)); }, INTERVAL_MS);
  console.log('[billing job] started (every 5 min)');
}

module.exports = { start, runCycle };