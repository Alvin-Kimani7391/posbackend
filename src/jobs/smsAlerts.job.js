/**
 * smsAlerts.job.js - hourly sweep for reminder-type customer SMS (uncollected items, service due, warranty and
 * insurance expiry). "Ready for collection" texts are NOT here: they fire the moment the job becomes READY.
 * Safe to run on several instances: every alert has a unique dedupeKey, so the worst case is a skipped duplicate.
 */
const Business = require('../models/Business');
const alerts = require('../services/sms/alerts.service');

const EVERY_MS = 60 * 60 * 1000;
let timer = null; let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const cursor = Business.find({
      status: 'active',
      $or: ['readyReminder', 'serviceDue', 'warrantyExpiring', 'insuranceExpiring'].map((k) => ({ [`smsAlerts.${k}.enabled`]: true })),
    }).select('_id').lean().cursor();
    for await (const b of cursor) {
      try { await alerts.runReminders(b._id); } catch (e) { console.error('[sms alerts job] business failed', String(b._id), e.message); }
    }
  } catch (e) { console.error('[sms alerts job] tick failed', e.message); } finally { running = false; }
}

function start() {
  if (timer) return;
  setTimeout(tick, 60 * 1000).unref();
  timer = setInterval(tick, EVERY_MS);
  timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop, tick };