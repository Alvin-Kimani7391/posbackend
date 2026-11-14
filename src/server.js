require('./config/env');
const app = require('./app');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const { port } = require('./config/env');

let server;
let shutdownStarted = false;

async function start() {
  await connectDB();
  // Repair compound sparse unique indexes (only one barcode-less product per business was allowed). Idempotent.
  try { await require('./config/fixIndexes').fixSparseCompoundIndexes(); } catch (err) { logger.warn('Index repair skipped', { error: err.message }); }
  // Repair products saved with Expiry ticked but Batch tracking off (their expiry dates could never be stored). Idempotent.
  try {
    const { normalizeExpiryProducts } = require('./services/batch.service');
    const fixed = await normalizeExpiryProducts();
    if (fixed) logger.info(`Expiry tracking: switched on batch tracking for ${fixed} product(s)`);
  } catch (err) {
    logger.warn('Expiry tracking repair skipped', { error: err.message });
  }
  server = app.listen(port, () => {
    logger.info(`POS backend listening on port ${port}`);
  });

  // Jobs run here ONLY when RUN_JOBS is not 'false'. Default = unchanged behaviour.
  // Blue/Green/staging API slots set RUN_JOBS=false; src/worker.js runs the jobs.
  if (process.env.RUN_JOBS !== 'false') {
    // real server process (never when app.js is imported by tests).
    require('./jobs/etimsRetry.job').start();
    require('./jobs/mpesaReconcile.job').start();
    require('./jobs/billing.job').start();
    require('./jobs/crmSync.job').start();
    require('./jobs/smsQueue.job').start();
    require('./jobs/smsAlerts.job').start();
    require('./jobs/offlineWatch.job').start();
    require('./jobs/expiryAlerts.job').start();
    require('./jobs/lowStockAlerts.job').start();
    require('./jobs/restaurant.job').start();
    require('./jobs/rider.job').start();
    require('./jobs/tv.job').start();
    require('./jobs/weeklyReport.job').start();
  }
}

async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;

  logger.info(`Received ${signal}, shutting down gracefully`);
  app.set('shuttingDown', true); // /health/ready now answers 503 so nothing new is routed here
  try { require('./services/delivery/realtime.hub').closeAll(); } catch (e) { /* open live streams must not hold the server open */ }

  if (server) {
    const forceExit = setTimeout(() => {
      logger.error('API graceful shutdown exceeded 60 seconds');
      process.exit(1);
    }, 60000);
    forceExit.unref();

    server.close(async (err) => {
      clearTimeout(forceExit);

      if (err) {
        logger.error('HTTP server close failed during shutdown', { error: err.message });
        process.exit(1);
        return;
      }

      try {
        await disconnectDB();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Database disconnect failed during shutdown', { error: error.message });
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

start();