/**
 * lowStockAlerts.job.js - 06:30 Nairobi every morning, text the owner of each shop that switched the low-stock SMS on.
 * Also once shortly after start-up (so a server that was down at 06:30 still sends). Safe on several instances and
 * restarts: every SMS has a unique dedupeKey per day / week, so the worst case is a skipped duplicate.
 */
const cron = require('node-cron');
const lowStock = require('../services/lowStockAlerts.service');

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { await lowStock.runAll(); } catch (e) { console.error('[low stock job]', e.message); } finally { running = false; }
}

function start() {
  cron.schedule('30 6 * * *', () => tick(), { timezone: 'Africa/Nairobi' });
  setTimeout(tick, 3 * 60 * 1000).unref();
}

module.exports = { start, tick };
