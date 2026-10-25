/** What the customer's phone may do on the tracking page. Everything is addressed by the storefront QR token + the delivery's own trackKey. */
const ApiError = require('../../utils/ApiError');
const RestaurantOrder = require('../../models/RestaurantOrder');
const storefront = require('../storefront/storefront.service');
const tracking = require('./tracking.service');
const push = require('./push.service');
const stream = require('./stream.service');

const biz = async (token) => (await storefront.open(token)).businessId;

const live = async (token, key, query) => tracking.customerLive(await biz(token), key, query);
const move = async (token, key, body) => tracking.customerMove(await biz(token), key, body);
const rate = async (token, key, body) => tracking.rate(await biz(token), key, body);
const openStream = async (token, key, req, res) => stream.customerStream(await biz(token), key, req, res);

/** Lock-screen alerts ("Your rider is 100 m away") for this one delivery. The subscription expires 12 hours after it is made. */
async function subscribePush(token, key, sub, userAgent) {
  const businessId = await biz(token);
  if (!(await RestaurantOrder.exists({ businessId, 'delivery.trackKey': String(key) }))) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND');
  const r = await push.subscribe(businessId, { audience: 'CUSTOMER', trackKey: String(key) }, sub, { userAgent, keepUntil: new Date(Date.now() + 12 * 3600000) });
  return { ...r, publicKey: push.publicKey() };
}
const pushKey = async (token) => { await biz(token); return { enabled: push.enabled(), publicKey: push.publicKey() }; };

module.exports = { live, move, rate, openStream, subscribePush, pushKey };
