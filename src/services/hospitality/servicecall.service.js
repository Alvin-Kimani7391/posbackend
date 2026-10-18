/** "Call the waiter", "bring the bill", "clean my room": raised from a QR code (or logged by staff), answered by staff. */
const ServiceCall = require('../../models/ServiceCall');
const RestaurantOrder = require('../../models/RestaurantOrder');
const HousekeepingTask = require('../../models/HousekeepingTask');
const ApiError = require('../../utils/ApiError');
const { ROLES } = require('../../constants/roles');
const H = require('../../constants/hospitality');
const C = require('./common');

const LABEL = { WAITER: 'wants a waiter', BILL: 'asked for the bill', ASSISTANCE: 'needs help', CLEANING: 'asked for cleaning', HOUSEKEEPING: 'asked for housekeeping', MAINTENANCE: 'reported a problem', RECEPTION: 'wants reception', CHECKOUT: 'asked to check out', OTHER: 'needs something' };
const place = (c) => (c.tableName ? `Table ${c.tableName}` : `Room ${c.roomNumber}`);

async function notifyAudience(businessId, call, order) {
  const text = { type: call.kind === 'CHECKOUT' ? 'STAY_CHECKOUT_REQUEST' : (['CLEANING', 'HOUSEKEEPING'].includes(call.kind) ? 'HOUSEKEEPING_REQUEST' : 'GUEST_CALL'), title: `${place(call)} ${LABEL[call.kind]}`, message: call.note || `${place(call)} ${LABEL[call.kind]}.`, branchId: call.branchId, entityType: 'ServiceCall', entityId: call._id };
  const audience = H.CALL_AUDIENCE[call.kind];
  const waiterId = call.waiterId || order?.waiterId;
  if (audience === 'FLOOR') { if (waiterId) C.notifyUser(businessId, waiterId, text); await C.notifyRoles(businessId, call.branchId, waiterId ? C.FLOOR_LEAD_ROLES : [...C.FLOOR_LEAD_ROLES, ROLES.WAITER, ROLES.BARTENDER], text); }
  else if (audience === 'CASHIER') { if (waiterId) C.notifyUser(businessId, waiterId, text); await C.notifyRoles(businessId, call.branchId, C.CASHIER_ROLES, text); }
  else if (audience === 'HOUSEKEEPING') await C.notifyRoles(businessId, call.branchId, [ROLES.HOUSEKEEPER, ROLES.RECEPTIONIST, ROLES.MANAGER], text);
  else if (audience === 'FRONT_DESK') await C.notifyRoles(businessId, call.branchId, [ROLES.RECEPTIONIST, ROLES.MANAGER], text);
  else C.notifyManagement(businessId, text);
}

/** Raises a call. The same call from the same place inside the cool-down is merged (the guest pressing the button again). */
async function raise({ ctx, businessId, branchId, kind, table, room, stay, order, note, guestName, source = 'GUEST', actorId }) {
  if (!H.CALL_KINDS.includes(kind)) throw ApiError.badRequest('Unknown request', 'INVALID_CALL');
  const cool = (ctx.settings.guestOrdering?.callCooldownSeconds ?? 60) * 1000;
  const placeFilter = table ? { tableId: table._id } : { roomId: room._id };
  const open = await ServiceCall.findOne({ businessId, ...placeFilter, kind, status: { $in: ['OPEN', 'ACKNOWLEDGED'] } }).sort({ createdAt: -1 });
  if (open && (open.status === 'OPEN' || Date.now() - open.createdAt < cool)) { open.repeatCount += 1; if (note && !open.note) open.note = note; await open.save(); return { call: open, merged: true }; }
  const call = await ServiceCall.create({ businessId, branchId, kind, source, tableId: table?._id, tableName: table?.name, roomId: room?._id, roomNumber: room?.number, stayId: stay?._id, orderId: order?._id, note, guestName, waiterId: table?.waiterId || order?.waiterId, acknowledgedBy: undefined });
  if (kind === 'CLEANING' && room) await HousekeepingTask.create({ businessId, branchId, roomId: room._id, roomNumber: room.number, type: 'REQUEST', stayId: stay?._id, note: note || 'Guest asked for cleaning', auto: true, createdBy: actorId });
  await notifyAudience(businessId, call, order);
  return { call, merged: false };
}

async function list(businessId, user, { branchId, status, kind }) {
  C.requireCan(user, 'restaurant.guest.view', 'Needs permission');
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  f.status = status ? { $in: String(status).split(',') } : { $in: ['OPEN', 'ACKNOWLEDGED'] };
  if (kind) f.kind = kind;
  const calls = await ServiceCall.find(f).sort({ createdAt: 1 }).limit(200);
  if (!C.can(user, 'restaurant.orders.view_all') && !C.can(user, 'accommodation.housekeeping.manage')) return calls.filter((c) => !c.waiterId || String(c.waiterId) === String(user._id));
  return calls;
}

async function acknowledge(businessId, user, id) {
  C.requireCan(user, 'restaurant.guest.respond', 'Needs permission');
  const call = await ServiceCall.findOneAndUpdate({ _id: id, businessId, status: 'OPEN' }, { $set: { status: 'ACKNOWLEDGED', acknowledgedBy: user._id, acknowledgedByName: user.name, acknowledgedAt: new Date() } }, { new: true });
  if (!call) { const c = await ServiceCall.findOne({ _id: id, businessId }); if (!c) throw ApiError.notFound('Request not found', 'CALL_NOT_FOUND'); return c; }
  C.assertBranchAccess(user, call.branchId); return call;
}
async function resolve(businessId, user, id) {
  C.requireCan(user, 'restaurant.guest.respond', 'Needs permission');
  const call = await ServiceCall.findOne({ _id: id, businessId }); if (!call) throw ApiError.notFound('Request not found', 'CALL_NOT_FOUND'); C.assertBranchAccess(user, call.branchId);
  call.status = 'RESOLVED'; call.resolvedBy = user._id; call.resolvedAt = new Date(); if (!call.acknowledgedBy) { call.acknowledgedBy = user._id; call.acknowledgedByName = user.name; call.acknowledgedAt = new Date(); } await call.save(); return call;
}
/** Staff log a request on a guest's behalf (the guest phoned reception). */
async function create(businessId, user, input) {
  C.requireCan(user, 'restaurant.guest.respond', 'Needs permission');
  const RestaurantTable = require('../../models/RestaurantTable'); const Room = require('../../models/Room'); const Stay = require('../../models/Stay');
  const ctx = await C.getAccContext(businessId);
  const table = input.tableId ? await RestaurantTable.findOne({ _id: input.tableId, businessId }) : null; const room = input.roomId ? await Room.findOne({ _id: input.roomId, businessId }) : null;
  if (!table && !room) throw ApiError.badRequest('Choose a table or a room', 'PLACE_REQUIRED');
  const p = table || room; C.assertBranchAccess(user, p.branchId);
  const stay = room?.currentStayId ? await Stay.findById(room.currentStayId) : null;
  return raise({ ctx, businessId, branchId: p.branchId, kind: input.kind, table, room, stay, note: input.note, source: 'STAFF', actorId: user._id });
}

module.exports = { raise, list, acknowledge, resolve, create, notifyAudience };
