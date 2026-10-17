/**
 * expiryAlerts.job.js - every morning (06:00 Nairobi) tell management which stock is expired or about to expire.
 * Also runs once shortly after the server starts, so a server that was down at 06:00 still sends today's alert.
 * Safe on several instances and on restarts: the in-app alert is deduped per business per day and every SMS has a
 * unique dedupeKey, so the worst case is a skipped duplicate.
 */
const cron = require('node-cron');
const expiryAlerts = require('../services/expiryAlerts.service');

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await expiryAlerts.runAll(); } catch (e) { console.error('[expiry alerts job]', e.message); } finally { running = false; }
}

function start() {
  cron.schedule('0 6 * * *', () => tick(), { timezone: 'Africa/Nairobi' });
  setTimeout(tick, 2 * 60 * 1000).unref();
}

module.exports = { start, tick };
