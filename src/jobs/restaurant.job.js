const cron = require('node-cron');
const kitchen = require('../services/restaurant/kitchen.service');
const reservations = require('../services/restaurant/reservation.service');
const ingredients = require('../services/restaurant/ingredient.service');

const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(`[restaurant job] ${name} failed:`, e.message); } };

// Guest orders nobody accepted are withdrawn; bookings whose guest never came are released (when the owner chose automatic release); overdue departures are flagged.
async function accommodationSweep() {
  const Stay = require('../models/Stay'); const AccommodationSettings = require('../models/AccommodationSettings'); const stays = require('../services/hospitality/stay.service'); const C = require('../services/hospitality/common');
  const settings = await AccommodationSettings.find({ 'noShow.autoRelease': true }).select('businessId noShow');
  for (const s of settings) {
    const due = await Stay.find({ businessId: s.businessId, status: 'RESERVED', expectedCheckIn: { $lt: new Date(Date.now() - s.noShow.afterHours * 3600000) } }).select('_id').limit(100);
    for (const d of due) { try { await stays.markNoShow(s.businessId, { _id: null, name: 'Automatic', role: 'OWNER' }, d._id, { reason: 'Did not arrive' }, { auto: true }); } catch (e) { console.error('[accommodation] no-show release failed:', e.message); } }
  }
  const overdue = await Stay.find({ status: 'CHECKED_IN', expectedCheckOut: { $lt: new Date(Date.now() - 30 * 60000) }, overdueNotifiedAt: { $exists: false } }).select('businessId branchId stayNumber roomNumber guest.name').limit(200);
  for (const o of overdue) {
    await Stay.updateOne({ _id: o._id }, { $set: { overdueNotifiedAt: new Date() } });
    C.notifyRoles(o.businessId, o.branchId, ['RECEPTIONIST', 'MANAGER'], { type: 'STAY_OVERDUE', title: `Room ${o.roomNumber} is past check-out time`, message: `${o.guest.name} has not checked out (${o.stayNumber}).`, entityType: 'Stay', entityId: o._id });
  }
}

function start() {
  cron.schedule('* * * * *', safe('guest payments', () => require('../services/hospitality/guest-portal.service').sweep()));
  cron.schedule('* * * * *', safe('storefront deposits', () => require('../services/storefront/storefront.service').sweep()));
  cron.schedule('* * * * *', safe('self-service payments', () => require('../services/restaurant/selfservice.service').sweep()));
  cron.schedule('*/2 * * * *', safe('self-service expiry', () => require('../services/restaurant/selfservice.service').expireStale()));
  cron.schedule('*/5 * * * *', safe('guest orders expiry', () => require('../services/hospitality/guest.service').expireStale()));
  cron.schedule('*/15 * * * *', safe('accommodation sweep', accommodationSweep));
  cron.schedule('* * * * *', safe('kitchen delays', () => kitchen.delayAlerts()));           // every minute
  cron.schedule('* * * * *', safe('reservations', () => reservations.sweep()));              // every minute: lock tables before the booking, late alerts, no-shows, reminders
  cron.schedule('15 * * * *', safe('ingredient expiry', () => ingredients.expirySweep()));   // hourly
}
module.exports = { start };
