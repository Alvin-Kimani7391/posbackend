require('./config/env');
const app = require('./app');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const { port } = require('./config/env');

let server;

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

  // Background jobs - only after a DB connection exists, and only in the
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
}

async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  try { require('./services/delivery/realtime.hub').closeAll(); } catch (e) { /* open live streams must not hold the server open */ }
  if (server) {
    server.close(async () => {
      await disconnectDB();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    // Force-exit if graceful shutdown hangs
    setTimeout(() => process.exit(1), 10000).unref();
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