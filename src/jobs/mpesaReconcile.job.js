const cron = require('node-cron');
const mpesaService = require('../services/mpesa.service');
const offlineMpesa = require('../services/offline-mpesa.service');

// Every minute, close out any PENDING STK attempt whose window has clearly
// passed but was never resolved locally (browser closed, tab lost focus, etc).
function start() {
  cron.schedule('* * * * *', () => {
    mpesaService.reapAbandoned().catch((err) => console.error('[mpesa reconcile job]', err));
  });

  cron.schedule('*/2 * * * *', () => {
    offlineMpesa.sweep().catch((err) => console.error('[offline mpesa sweep]', err));
  });
  
}

module.exports = { start };