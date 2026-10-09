const sms = require('../services/sms/sms.service');

let timer; let n = 0;
function start() {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      await sms.processQueue();
      if (++n % 6 === 0) await sms.reconcilePayments(); // about every 30s
    } catch (e) { console.error('[sms] queue tick failed', e.message); }
  }, 5000);
  if (timer.unref) timer.unref();
}
module.exports = { start };