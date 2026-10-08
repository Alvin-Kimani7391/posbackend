/**
 * crmSync.job.js - safety net behind the real-time capture.
 *   every 2 min : syncRecent() for every business (picks up sales/refunds touched since the cursor)
 *   every ~20 h : refreshLifecycles() so labels drift correctly (active -> inactive) with no new sale
 * Start once from server.js:  require('./jobs/crmSync.job').start();
 */
const Business = require('../models/Business');
const crm = require('../services/crm.service');

const SYNC_EVERY_MS = 2 * 60 * 1000;
const REFRESH_EVERY_MS = 20 * 60 * 60 * 1000;
const FIRST_RUN_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

let timer = null;
let running = false;
let lastRefreshAt = 0;

async function tick() {
  if (running) return;
  running = true;
  try {
    const doRefresh = Date.now() - lastRefreshAt > REFRESH_EVERY_MS;
    const since = new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);
    const cursor = Business.find().select('_id').lean().cursor();
    for await (const b of cursor) {
      try {
        await crm.syncRecent(b._id, since);
        if (doRefresh) await crm.refreshLifecycles(b._id);
      } catch (err) {
        console.error('[crm job] business failed', String(b._id), err.message);
      }
    }
    if (doRefresh) lastRefreshAt = Date.now();
  } catch (err) {
    console.error('[crm job] tick failed', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return;
  setTimeout(tick, 20 * 1000).unref();
  timer = setInterval(tick, SYNC_EVERY_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };