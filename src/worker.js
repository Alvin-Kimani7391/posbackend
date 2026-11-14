// Dedicated background-job process. API slots run with RUN_JOBS=false.
if (process.env.DOTENV_CONFIG_PATH) require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH });
require('./config/env');

const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const fs = require('fs');

const JOBS = [
  'etimsRetry', 'mpesaReconcile', 'billing', 'crmSync', 'smsQueue', 'smsAlerts',
  'offlineWatch', 'expiryAlerts', 'lowStockAlerts', 'restaurant', 'rider', 'tv',
  'weeklyReport',
];

const started = [];
const cronTasks = [];
const active = new Set();
const READY = process.env.WORKER_READY_FILE;
let beat;
let shuttingDown = false;
let shutdownPromise;

function trackCallback(fn, label) {
  return function trackedJobCallback(...args) {
    if (shuttingDown) return;
    const result = fn.apply(this, args);
    if (!result || typeof result.then !== 'function') return result;

    const pending = Promise.resolve(result);
    active.add(pending);
    pending.then(
      () => active.delete(pending),
      (err) => {
        active.delete(pending);
        logger.error('Worker job callback failed', {
          job: label,
          error: err?.message || String(err),
        });
      }
    );
    return pending;
  };
}

function writeReady() {
  if (!READY || shuttingDown) return;
  try {
    fs.writeFileSync(READY, JSON.stringify({
      release: process.env.RELEASE_ID || '',
      pid: process.pid,
      jobs: started.length,
      ts: Date.now(),
    }));
  } catch (e) {
    logger.warn('Worker: cannot write ready file', { error: e.message });
  }
}

async function start() {
  await connectDB();

  // Track every node-cron callback and retain its task for shutdown.
  const cron = require('node-cron');
  const originalSchedule = cron.schedule;
  cron.schedule = function trackedSchedule(expression, callback, options) {
    const task = originalSchedule.call(
      this,
      expression,
      trackCallback(callback, expression),
      options
    );
    cronTasks.push(task);
    return task;
  };

  // Wrap timers only while each job is being initialized. This tracks async
  // interval/timeout callbacks without changing MongoDB's runtime timers.
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;

  for (const name of JOBS) {
    const job = require('./jobs/' + name + '.job');
    started.push({ name, job });

    global.setTimeout = function trackedTimeout(callback, ...args) {
      return originalSetTimeout.call(
        this,
        typeof callback === 'function' ? trackCallback(callback, name) : callback,
        ...args
      );
    };
    global.setInterval = function trackedInterval(callback, ...args) {
      return originalSetInterval.call(
        this,
        typeof callback === 'function' ? trackCallback(callback, name) : callback,
        ...args
      );
    };

    try {
      await job.start();
    } finally {
      global.setTimeout = originalSetTimeout;
      global.setInterval = originalSetInterval;
    }

    logger.info('Worker: started job ' + name);
  }

  logger.info('Worker running ' + started.length + ' jobs');
  writeReady();
  beat = setInterval(writeReady, 15000);
  beat.unref();
}

async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    shuttingDown = true;
    const deadline = Date.now() + 60000;

    logger.info('Worker received ' + signal + ', stopping new job work');

    if (beat) clearInterval(beat);
    try { if (READY) fs.unlinkSync(READY); } catch (_) {}

    const remaining = () => Math.max(0, deadline - Date.now());

    // Stop cron schedules first so no new cron callbacks can begin.
    for (const task of cronTasks) {
      try {
        task.stop();
      } catch (e) {
        logger.warn('Worker: cron task stop failed', { error: e.message });
      }
    }

    // Job stop operations and callback draining share one deadline.
    for (const { name, job } of [...started].reverse()) {
      if (remaining() <= 0) break;

      try {
        if (typeof job.stop === 'function') {
          let stopTimer;
          try {
            await Promise.race([
              Promise.resolve().then(() => job.stop()),
              new Promise((_, reject) => {
                stopTimer = setTimeout(
                  () => reject(new Error('Shutdown deadline exceeded')),
                  remaining()
                );
              }),
            ]);
          } finally {
            if (stopTimer) clearTimeout(stopTimer);
          }
        }
      } catch (e) {
        logger.error('Worker: job stop failed', {
          job: name,
          error: e.message,
        });
      }
    }

    while (active.size > 0 && remaining() > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, remaining()))
      );
    }

    if (Date.now() >= deadline || active.size > 0) {
      logger.error('Worker shutdown deadline exceeded; refusing normal MongoDB disconnect', {
        activeCallbacks: active.size,
      });
      process.exit(1);
      return;
    }

    try {
      await disconnectDB();
      logger.info('Worker drained; MongoDB disconnected');
      process.exit(0);
    } catch (e) {
      logger.error('Worker MongoDB disconnect failed', { error: e.message });
      process.exit(1);
    }
  })();

  return shutdownPromise;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) =>
  logger.error('Worker unhandled rejection', { reason: r?.message || r })
);
process.on('uncaughtException', (e) => {
  logger.error('Worker uncaught exception', { error: e.message });
  process.exit(1);
});

start().catch((e) => {
  logger.error('Worker failed to start', { error: e.message });
  process.exit(1);
});
