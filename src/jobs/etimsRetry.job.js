const cron = require('node-cron');
const etimsService = require('../services/etims.service');

// Every 5 minutes, sweep every business's failed-but-retryable eTIMS submissions.
function start() {
  cron.schedule('*/5 * * * *', () => {
    etimsService.retryAllDue().catch((err) => console.error('[etims retry job]', err));
  });
}

module.exports = { start };