/**
 * Expiry alerts: the daily check that tells management (in-app notification) and, if switched on, the owner (SMS)
 * what is expired or about to expire. Read-only on stock: it never writes anything off by itself.
 *
 *  - In-app: one EXPIRY_ALERT per business per day to every owner / admin / manager (deduped by day; `force` skips that).
 *  - SMS: see sms/alerts.service#sendExpiryDigest (off by default; daily or weekly; needs sender ID + credits).
 */
const Business = require('../models/Business');
const Notification = require('../models/Notification');
const batchService = require('./batch.service');
const notificationService = require('./notification.service');
const smsAlerts = require('./sms/alerts.service');
const { getBusinessContext } = require('../utils/businessContext');

const EAT_OFFSET = 3 * 3600000;
const todayKey = () => new Date(Date.now() + EAT_OFFSET).toISOString().slice(0, 10);
const dayText = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function describe(summary, fmt) {
  const { expired, critical, warning } = summary;
  const parts = [];
  if (expired.batches) parts.push(`${expired.batches} batch${expired.batches === 1 ? '' : 'es'} already expired (${expired.units} units, ${fmt(expired.costValue)} at cost)`);
  if (critical.batches) parts.push(`${critical.batches} expiring within ${summary.criticalDays} days (${fmt(critical.costValue)} at cost)`);
  if (warning.batches) parts.push(`${warning.batches} more within ${summary.warningDays} days`);
  const soonest = summary.top.slice(0, 3).map((t) => `${t.name} (batch ${t.batchNumber}, ${t.daysLeft < 0 ? `expired ${dayText(t.expiryDate)}` : t.daysLeft === 0 ? 'expires today' : `${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left`})`).join('; ');
  return `${parts.join('; ')}.${soonest ? ` Soonest: ${soonest}.` : ''} Open Batches & expiry to write off, return to the supplier, or sell the oldest first.`;
}

/** One business. Returns { notified, sms, summary }. Never throws for a quiet business. */
async function runForBusiness(businessId, { force = false } = {}) {
  const thresholds = await batchService.getAlertSettings(businessId);
  const summary = await batchService.expirySummary(businessId, { thresholds });
  const result = { notified: false, summary: { expired: summary.expired.batches, critical: summary.critical.batches, warning: summary.warning.batches } };
  const total = summary.expired.batches + summary.critical.batches + summary.warning.batches;

  if (total && (thresholds.notifyEnabled || force)) {
    const day = todayKey();
    const already = !force && await Notification.exists({ businessId, type: 'EXPIRY_ALERT', 'data.day': day });
    if (!already) {
      const ctx = await getBusinessContext(businessId);
      const urgent = summary.expired.batches > 0 || summary.critical.batches > 0;
      await notificationService.notifyManagement(businessId, {
        type: 'EXPIRY_ALERT',
        severity: urgent ? 'critical' : 'warning',
        title: summary.expired.batches ? 'Expired stock needs action' : urgent ? 'Stock is about to expire' : 'Stock will expire soon',
        message: describe(summary, (c) => ctx.fmt(c)),
        data: { day, kind: 'EXPIRY', expired: summary.expired, critical: summary.critical, warning: summary.warning, byBranch: summary.byBranch, link: (summary.ingredients && (summary.ingredients.expired.batches + summary.ingredients.critical.batches + summary.ingredients.warning.batches)) ? 'hx-stock.html#batches' : 'batches.html' },
        entityType: 'Batch',
      });
      result.notified = true;
    }
  }

  // SMS digest uses its own look-ahead window (default 30 days), so it gets its own summary when that differs.
  try {
    const biz = await Business.findById(businessId).select('smsAlerts').lean();
    const days = biz?.smsAlerts?.expiryDigest?.daysBefore || 30;
    if (biz?.smsAlerts?.expiryDigest?.enabled) {
      const smsSummary = await batchService.expirySummary(businessId, { thresholds, criticalDays: days, warningDays: days });
      result.sms = await smsAlerts.sendExpiryDigest(businessId, smsSummary);
    }
  } catch (e) { console.error('[expiry alerts] sms digest failed', String(businessId), e.message); }
  return result;
}

/** Every active business that uses batches / expiry. */
async function runAll() {
  const cursor = Business.find({
    status: 'active', subscriptionStatus: { $nin: ['suspended', 'cancelled'] },
    $or: [{ 'featureSettings.expiryTracking': true }, { 'featureSettings.batchTracking': true }, { 'featureSettings.recipeManagement': true }],
  }).select('_id').lean().cursor();
  let n = 0;
  for await (const b of cursor) {
    try { await runForBusiness(b._id); n += 1; } catch (e) { console.error('[expiry alerts] business failed', String(b._id), e.message); }
  }
  return n;
}

module.exports = { runForBusiness, runAll };
