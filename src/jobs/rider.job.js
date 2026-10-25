const cron = require('node-cron');
const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`[rider job] ${name} failed:`, e.message); } };

function start() {
  // riders gone quiet mid-delivery, riders who forgot to go offline
  cron.schedule('* * * * *', safe('presence', () => require('../services/delivery/tracking.service').sweep()));
  // rider M-PESA payments whose callback was missed, cash that has been held too long
  cron.schedule('* * * * *', safe('rider payments', () => require('../services/delivery/delivery-payment.service').sweep()));
}
module.exports = { start };
