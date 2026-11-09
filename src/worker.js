// Dedicated background-job process. Blue/Green API slots run with RUN_JOBS=false;
// only this process (PM2 name: sixstar-worker, ONE instance) runs the jobs.
if (process.env.DOTENV_CONFIG_PATH) require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH });
require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');

const JOBS = [
  'etimsRetry', 'mpesaReconcile', 'billing', 'crmSync', 'smsQueue', 'smsAlerts',
  'offlineWatch', 'expiryAlerts', 'lowStockAlerts', 'restaurant', 'rider', 'tv',
  'weeklyReport',
];

const started = [];
const fs = require('fs');
const READY = process.env.WORKER_READY_FILE;
let beat;
function writeReady() {
  if (!READY) return;
  try { fs.writeFileSync(READY, JSON.stringify({ release: process.env.RELEASE_ID || '', pid: process.pid, jobs: started.length, ts: Date.now() })); } catch (e) { logger.warn('Worker: cannot write ready file', { error: e.message }); }
}

async function start() {
  await connectDB();
  for (const name of JOBS) {
    const job = require(`./jobs/${name}.job`);
    job.start();
    started.push({ name, job });
    logger.info(`Worker: started job ${name}`);
  }
  logger.info(`Worker running ${started.length} jobs`);
  writeReady(); // proves: DB connected + every job started. deploy.sh waits for this.
  beat = setInterval(writeReady, 15000); beat.unref();
}

async function shutdown(signal) {
  logger.info(`Worker received ${signal}, stopping`);
  if (beat) clearInterval(beat);
  try { if (READY) fs.unlinkSync(READY); } catch (e) { /* ignore */ }
  for (const { name, job } of started) {
    try { if (typeof job.stop === 'function') job.stop(); }
    catch (e) { logger.warn(`Worker: could not stop ${name}`, { error: e.message }); }
  }
  try { await disconnectDB(); } catch (e) { /* ignore */ }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => logger.error('Worker unhandled rejection', { reason: r?.message || r }));
process.on('uncaughtException', (e) => { logger.error('Worker uncaught exception', { error: e.message }); process.exit(1); });

start().catch((e) => { logger.error('Worker failed to start', { error: e.message }); process.exit(1); });