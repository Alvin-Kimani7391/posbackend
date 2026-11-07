/**
 * weeklyReport.job.js - the weekly shop-performance email (+ Low Stock and Expiry PDFs).
 * Checks every 5 minutes whether one of the admin's schedule slots (default Saturday 10:00 Nairobi) is due.
 * Safe on restarts and several instances: each slot is claimed atomically in the database before sending.
 */
const cron = require('node-cron');
const weekly = require('../services/weeklyReport');

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { const r = await weekly.tick(); if (r && r.ran) console.log('[weekly report] sent', JSON.stringify(r)); }
  catch (e) { console.error('[weekly report job]', e.message); }
  finally { running = false; }
}

function start() {
  cron.schedule('*/5 * * * *', () => tick(), { timezone: 'Africa/Nairobi' });
  setTimeout(tick, 4 * 60 * 1000).unref();
}

module.exports = { start, tick };
