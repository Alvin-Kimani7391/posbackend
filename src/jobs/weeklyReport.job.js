/**
 * weeklyReport.job.js - the weekly shop-performance email (+ Low Stock and Expiry PDFs).
 * Checks every 5 minutes whether one of the admin's schedule slots (default Saturday 10:00 Nairobi) is due.
 * Safe on restarts and several instances: each slot is claimed atomically in the database before sending.
 */
const cron = require('node-cron');
const weekly = require('../services/weeklyReport');

let running = false;
let task = null;
let kick = null;

async function tick() {
  if (running) return;
  running = true;
  try { const r = await weekly.tick(); if (r && r.ran) console.log('[weekly report] sent', JSON.stringify(r)); }
  catch (e) { console.error('[weekly report job]', e.message); }
  finally { running = false; }
}

function start() {
  if (task) return; // never schedule twice in one process
  task = cron.schedule('*/5 * * * *', () => tick(), { timezone: 'Africa/Nairobi' });
  kick = setTimeout(tick, 4 * 60 * 1000);
  kick.unref();
}

// Lets the worker shut down cleanly (SIGTERM during a deploy): no new ticks start after this.
function stop() {
  if (task) { task.stop(); task = null; }
  if (kick) { clearTimeout(kick); kick = null; }
}

module.exports = { start, stop, tick };