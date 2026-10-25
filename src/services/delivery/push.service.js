/**
 * Web Push (the lock-screen notification in the customer's and rider's phone, even when the page is closed).
 * Needs the optional `web-push` package and VAPID keys; with either missing, push quietly does nothing and the in-page alerts,
 * the live stream and the notification centre still work.
 *   npm i web-push && npx web-push generate-vapid-keys   ->   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@yourbusiness.co.ke)
 */
const PushSubscription = require('../../models/PushSubscription');
const logger = require('../../utils/logger');

let webpush = null; let ready = false;
function init() {
  if (ready || webpush === false) return ready;
  try {
    webpush = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:support@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      ready = true;
    }
  } catch (e) { webpush = false; }
  return ready;
}
const publicKey = () => (init() ? process.env.VAPID_PUBLIC_KEY : null);
const enabled = () => init();

/** Saves (or refreshes) a subscription. `owner` is { audience: 'CUSTOMER', trackKey } or { audience: 'STAFF', userId }. */
async function subscribe(businessId, owner, sub, { userAgent, keepUntil } = {}) {
  const doc = { businessId, audience: owner.audience, trackKey: owner.trackKey, userId: owner.userId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, userAgent, failures: 0, expiresAt: keepUntil };
  await PushSubscription.updateOne({ endpoint: sub.endpoint }, { $set: doc }, { upsert: true });
  return { enabled: enabled() };
}
const unsubscribe = (endpoint) => PushSubscription.deleteOne({ endpoint });

async function deliver(subs, payload) {
  if (!init() || !subs.length) return 0;
  const body = JSON.stringify(payload); let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, body, { TTL: payload.ttl || 120, urgency: payload.urgency || 'high' });
      sent += 1;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await PushSubscription.deleteOne({ _id: s._id });   // the phone unsubscribed
      else { logger.warn('Web push failed', { status: e.statusCode, error: e.message }); await PushSubscription.updateOne({ _id: s._id }, { $inc: { failures: 1 } }); }
    }
  }));
  return sent;
}
/** payload: { title, body, tag, url, data }. Never throws. */
const toCustomer = async (businessId, trackKey, payload) => { try { return await deliver(await PushSubscription.find({ businessId, audience: 'CUSTOMER', trackKey, failures: { $lt: 5 } }).limit(10), payload); } catch (e) { logger.warn('push toCustomer', { error: e.message }); return 0; } };
const toUsers = async (businessId, userIds, payload) => { try { return await deliver(await PushSubscription.find({ businessId, audience: 'STAFF', userId: { $in: userIds }, failures: { $lt: 5 } }).limit(60), payload); } catch (e) { logger.warn('push toUsers', { error: e.message }); return 0; } };

module.exports = { publicKey, enabled, subscribe, unsubscribe, toCustomer, toUsers };
