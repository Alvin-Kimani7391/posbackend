/**
 * Live streams (Server-Sent Events) for the rider's phone, the staff live board and the customer's tracking page.
 *
 * A browser EventSource cannot send an Authorization header, so staff / riders first ask for a 2-minute STREAM TICKET
 * (POST .../stream-ticket, normal login required) and open  GET .../stream?ticket=...  with it. The ticket only opens a stream, nothing else.
 * Customers need no ticket: their unguessable trackKey is the key (same as the polling endpoint).
 * Every stream has a polling twin (GET .../live, .../board, .../dashboard), so a dropped stream only costs a few seconds.
 */
const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../../config/env');
const User = require('../../models/User');
const RestaurantOrder = require('../../models/RestaurantOrder');
const ApiError = require('../../utils/ApiError');
const hub = require('./realtime.hub');
const tracking = require('./tracking.service');
const C = require('../restaurant/common');

const PURPOSE = 'delivery-stream';
const issueTicket = (user, scope) => ({ ticket: jwt.sign({ sub: String(user._id), businessId: user.businessId ? String(user.businessId) : undefined, purpose: PURPOSE, scope }, jwtConfig.secret, { expiresIn: '2m' }), expiresInSec: 120 });

async function userFromTicket(ticket, scope) {
  let p;
  try { p = jwt.verify(String(ticket || ''), jwtConfig.secret); } catch (e) { throw ApiError.unauthorized('The live connection expired. Please reconnect.', 'STREAM_TICKET_INVALID'); }
  if (p.purpose !== PURPOSE || p.scope !== scope) throw ApiError.unauthorized('That ticket cannot open this stream.', 'STREAM_TICKET_INVALID');
  const user = await User.findById(p.sub);
  if (!user || user.status !== 'active' || String(user.businessId) !== String(p.businessId)) throw ApiError.unauthorized('Account is inactive or no longer exists', 'STREAM_TICKET_INVALID');
  return user;
}

/** Rider: his own channel (new assignment, payment confirmed, customer moved, near destination). */
async function riderStream(req, res) {
  const user = await userFromTicket(req.query.ticket, 'rider');
  if (!C.can(user, 'restaurant.delivery.self')) throw ApiError.forbidden('Missing permission: restaurant.delivery.self', 'PERMISSION_DENIED');
  hub.subscribe(hub.ch.user(user._id), req, res, { hello: { ok: true, riderId: user._id, serverTime: new Date() } });
}

const branchMatcher = (scope) => {
  if (scope === null) return null;                                   // owner / admin: everything
  const ids = scope.map(String);
  return (p) => (p.branchId && ids.includes(String(p.branchId))) || (Array.isArray(p.branchIds) && (!p.branchIds.length || p.branchIds.some((b) => ids.includes(String(b)))));
};

/** Owner / manager / cashier: every rider, delivery and cash event of the branches they may see. */
async function staffStream(req, res) {
  const user = await userFromTicket(req.query.ticket, 'staff');
  if (!C.can(user, 'restaurant.delivery.view')) throw ApiError.forbidden('Missing permission: restaurant.delivery.view', 'PERMISSION_DENIED');
  const scope = C.branchScope(user, req.query.branchId || undefined);
  const hello = await tracking.liveBoard(user.businessId, user, { branchId: req.query.branchId || undefined });
  hub.subscribe(hub.ch.biz(user.businessId), req, res, { filter: branchMatcher(scope) || undefined, hello });
}

/** Customer: one delivery. `open` resolves the storefront QR token to its business. */
async function customerStream(businessId, trackKey, req, res) {
  const exists = await RestaurantOrder.exists({ businessId, 'delivery.trackKey': String(trackKey) });
  if (!exists) throw ApiError.notFound('We could not find that order.', 'ORDER_NOT_FOUND');
  const hello = await tracking.customerLive(businessId, trackKey);
  hub.subscribe(hub.ch.track(trackKey), req, res, { hello });
}

module.exports = { issueTicket, riderStream, staffStream, customerStream };
