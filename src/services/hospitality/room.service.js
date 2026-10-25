/** Room types, rooms, room status, housekeeping and the room rack (what the front desk looks at all day). */
const Room = require('../../models/Room');
const RoomType = require('../../models/RoomType');
const Stay = require('../../models/Stay');
const HousekeepingTask = require('../../models/HousekeepingTask');
const AccommodationSettings = require('../../models/AccommodationSettings');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const T = require('../../utils/hospitalityTime');
const stays = require('./stay.service');
const C = require('./common');

// ------------------------------------------------------------ settings
async function getSettings(businessId) { return (await C.getAccContext(businessId)).acc; }
async function updateSettings(businessId, userId, patch) {
  const { acc } = await C.getAccContext(businessId);
  const merge = (target, src) => { for (const [k, v] of Object.entries(src)) { if (v && typeof v === 'object' && !Array.isArray(v)) { if (!target[k]) target[k] = {}; merge(target[k], v); } else target[k] = v; } };
  for (const [k, v] of Object.entries(patch)) { if (v && typeof v === 'object' && !Array.isArray(v)) { const cur = acc[k] && acc[k].toObject ? acc[k].toObject() : (acc[k] || {}); merge(cur, v); acc[k] = cur; } else acc[k] = v; }
  await acc.save();
  await C.audit({ businessId, userId, action: 'accommodation.settings.update', entityType: 'AccommodationSettings', entityId: acc._id, newValue: patch });
  return acc;
}

// ------------------------------------------------------------ room types
const listRoomTypes = (businessId, { includeInactive } = {}) => RoomType.find({ businessId, ...(includeInactive ? {} : { active: true }) }).sort({ sortOrder: 1, name: 1 });
async function createRoomType(businessId, userId, input) {
  try { const t = await RoomType.create({ ...input, businessId }); await C.audit({ businessId, userId, action: 'accommodation.roomtype.create', entityType: 'RoomType', entityId: t._id, newValue: { name: t.name, baseRate: t.baseRate } }); return t; }
  catch (e) { if (e.code === 11000) throw ApiError.conflict('A room type with that name already exists', 'DUPLICATE_ROOM_TYPE'); throw e; }
}
async function updateRoomType(businessId, userId, id, input) {
  const t = await RoomType.findOne({ _id: id, businessId }); if (!t) throw ApiError.notFound('Room type not found', 'ROOM_TYPE_NOT_FOUND');
  if (input.active === false && await Room.exists({ businessId, roomTypeId: id, active: true })) throw ApiError.conflict('Move or remove the rooms of this type first', 'ROOM_TYPE_IN_USE');
  const before = { baseRate: t.baseRate, weekendRate: t.weekendRate };
  Object.assign(t, input); await t.save();
  await C.audit({ businessId, userId, action: before.baseRate !== t.baseRate || before.weekendRate !== t.weekendRate ? 'accommodation.roomtype.rate_change' : 'accommodation.roomtype.update', entityType: 'RoomType', entityId: t._id, oldValue: before, newValue: { baseRate: t.baseRate, weekendRate: t.weekendRate } });
  return t;
}

// ------------------------------------------------------------ rooms
/** Guests book a room TYPE online, so photos added with a room also go on its type when the type has none yet. */
async function shareImages(businessId, roomTypeId, images) {
  if (images && images.length) await RoomType.updateOne({ _id: roomTypeId, businessId, $or: [{ images: { $exists: false } }, { images: { $size: 0 } }] }, { $set: { images: images.slice(0, 12) } });
}
async function createRoom(businessId, userId, input) {
  await C.assertBranch(businessId, input.branchId);
  if (!(await RoomType.exists({ _id: input.roomTypeId, businessId }))) throw ApiError.badRequest('Room type not found', 'ROOM_TYPE_NOT_FOUND');
  await shareImages(businessId, input.roomTypeId, input.images);
  try { const r = await Room.create({ ...input, businessId }); await C.audit({ businessId, branchId: r.branchId, userId, action: 'accommodation.room.create', entityType: 'Room', entityId: r._id, newValue: { number: r.number } }); return r; }
  catch (e) { if (e.code === 11000) throw ApiError.conflict(`Room ${input.number} already exists at this branch`, 'DUPLICATE_ROOM'); throw e; }
}
/** Create many rooms at once: numbers "101..110" style lists are expanded by the caller; duplicates are reported, not fatal. */
async function bulkCreateRooms(businessId, userId, { branchId, roomTypeId, numbers, floor, images }) {
  await C.assertBranch(businessId, branchId);
  if (!(await RoomType.exists({ _id: roomTypeId, businessId }))) throw ApiError.badRequest('Room type not found', 'ROOM_TYPE_NOT_FOUND');
  await shareImages(businessId, roomTypeId, images);
  const created = []; const skipped = [];
  for (const number of numbers) { try { created.push(await Room.create({ businessId, branchId, roomTypeId, number, floor, ...(images && images.length ? { images } : {}) })); } catch (e) { if (e.code === 11000) skipped.push(number); else throw e; } }
  await C.audit({ businessId, branchId, userId, action: 'accommodation.room.bulk_create', entityType: 'Room', newValue: { created: created.length, skipped } });
  return { created, skipped };
}
async function updateRoom(businessId, userId, id, input) {
  const r = await Room.findOne({ _id: id, businessId }); if (!r) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND');
  if (input.roomTypeId && !(await RoomType.exists({ _id: input.roomTypeId, businessId }))) throw ApiError.badRequest('Room type not found', 'ROOM_TYPE_NOT_FOUND');
  if (input.active === false && (r.currentStayId || await Stay.exists({ businessId, roomId: r._id, status: 'RESERVED' }))) throw ApiError.conflict('This room has a guest or bookings', 'ROOM_IN_USE');
  Object.assign(r, input); try { await r.save(); } catch (e) { if (e.code === 11000) throw ApiError.conflict('That room number already exists', 'DUPLICATE_ROOM'); throw e; }
  await C.audit({ businessId, branchId: r.branchId, userId, action: 'accommodation.room.update', entityType: 'Room', entityId: r._id });
  return r;
}

/** Takes a room out of service (or returns it). Refused while a guest is in it or a booking falls inside the period. */
async function setStatus(businessId, user, id, { status, reason, until }) {
  const r = await Room.findOne({ _id: id, businessId }); if (!r) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND'); C.assertBranchAccess(user, r.branchId);
  if (r.currentStayId) throw ApiError.conflict('A guest is in this room', 'ROOM_OCCUPIED');
  if (status === 'OUT_OF_ORDER') {
    if (!reason) throw ApiError.badRequest('Say why the room is out of order', 'REASON_REQUIRED');
    const end = until ? new Date(until) : new Date(Date.now() + 365 * 86400000);
    const clash = await stays.roomConflicts(businessId, r._id, new Date(), end);
    if (clash.length) throw ApiError.conflict(`Room ${r.number} has bookings in that period (${clash.map((c) => c.stayNumber).join(', ')}). Move them first.`, 'ROOM_HAS_BOOKINGS');
    r.status = 'OUT_OF_ORDER'; r.outOfOrder = { reason, since: new Date(), until: until ? new Date(until) : undefined, by: user._id };
  } else { r.status = 'AVAILABLE'; r.outOfOrder = undefined; }
  await r.save();
  await C.audit({ businessId, branchId: r.branchId, userId: user._id, action: 'accommodation.room.status', entityType: 'Room', entityId: r._id, newValue: { status, reason, until } });
  return r;
}

async function setHousekeeping(businessId, user, id, { housekeeping }) {
  const ctx = await C.getAccContext(businessId);
  const r = await Room.findOne({ _id: id, businessId }); if (!r) throw ApiError.notFound('Room not found', 'ROOM_NOT_FOUND'); C.assertBranchAccess(user, r.branchId);
  if (housekeeping === 'INSPECTED') C.requireCan(user, 'accommodation.housekeeping.manage', 'Only a supervisor can mark a room inspected');
  if (housekeeping === 'CLEAN' && ctx.acc.housekeeping.requireInspection && !C.can(user, 'accommodation.housekeeping.manage')) { /* allowed: it still needs inspecting before it can be sold */ }
  r.housekeeping = housekeeping; if (housekeeping === 'CLEAN') r.lastCleanedAt = new Date(); if (housekeeping === 'INSPECTED') r.lastInspectedAt = new Date();
  await r.save(); return r;
}

/** The room rack: every room with its guest, the next arrival and whether it can be sold right now. */
async function board(businessId, user, { branchId, date }) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getAccContext(businessId); C.assertAccommodation(ctx);
  const [rooms, types] = await Promise.all([Room.find({ businessId, branchId, active: true }).sort({ number: 1 }), RoomType.find({ businessId })]);
  const tById = new Map(types.map((t) => [String(t._id), t]));
  const today = date || T.todayIn(ctx.timeZone);
  const active = await Stay.find({ businessId, branchId, status: { $in: ['RESERVED', 'CHECKED_IN'] } }).select('stayNumber bookingCode status roomId guest.name guest.phone checkInDate checkOutDate expectedCheckIn expectedCheckOut adults children totals.balance checkoutRequestedAt').sort({ expectedCheckIn: 1 });
  const byRoom = new Map();
  for (const s of active) { const k = String(s.roomId); if (!byRoom.has(k)) byRoom.set(k, []); byRoom.get(k).push(s); }
  const out = rooms.map((r) => {
    const list = byRoom.get(String(r._id)) || [];
    const inHouse = list.find((s) => s.status === 'CHECKED_IN');
    const next = list.find((s) => s.status === 'RESERVED');
    const arrivingToday = list.find((s) => s.status === 'RESERVED' && s.checkInDate === today);
    const sellable = r.status === 'AVAILABLE' && ['CLEAN', 'INSPECTED'].includes(r.housekeeping) && (!ctx.acc.housekeeping.requireInspection || r.housekeeping === 'INSPECTED');
    return { ...r.toJSON(), roomType: tById.get(String(r.roomTypeId))?.name, inHouse: inHouse || null, nextArrival: next || null, arrivingToday: !!arrivingToday, dueOutToday: !!(inHouse && inHouse.checkOutDate <= today), overstay: !!(inHouse && inHouse.expectedCheckOut < new Date()), sellable };
  });
  const sum = (f) => out.filter(f).length;
  return { date: today, rooms: out, summary: { total: out.length, occupied: sum((r) => r.inHouse), vacantReady: sum((r) => !r.inHouse && r.sellable), vacantDirty: sum((r) => !r.inHouse && r.status === 'AVAILABLE' && !r.sellable), outOfOrder: sum((r) => r.status === 'OUT_OF_ORDER'), arrivingToday: sum((r) => r.arrivingToday), dueOutToday: sum((r) => r.dueOutToday) } };
}

// ------------------------------------------------------------ housekeeping tasks
async function listTasks(businessId, user, { branchId, status, assignedTo, mine }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (status) f.status = { $in: String(status).split(',') }; else f.status = { $in: ['PENDING', 'IN_PROGRESS'] };
  if (mine || !C.can(user, 'accommodation.housekeeping.manage')) f.$or = [{ assignedTo: user._id }, { assignedTo: { $exists: false } }, { assignedTo: null }]; else if (assignedTo) f.assignedTo = assignedTo;
  return HousekeepingTask.find(f).sort({ priority: -1, createdAt: 1 }).limit(300);
}
async function createTask(businessId, user, input) {
  C.requireCan(user, 'accommodation.housekeeping.manage', 'Creating housekeeping tasks needs permission');
  const room = await Room.findOne({ _id: input.roomId, businessId }); if (!room) throw ApiError.badRequest('Room not found', 'ROOM_NOT_FOUND'); C.assertBranchAccess(user, room.branchId);
  let assignedName; if (input.assignedTo) { const u = await User.findOne({ _id: input.assignedTo, businessId, status: 'active' }).select('name'); if (!u) throw ApiError.badRequest('Staff member not found', 'USER_NOT_FOUND'); assignedName = u.name; }
  return HousekeepingTask.create({ ...input, businessId, branchId: room.branchId, roomNumber: room.number, assignedName, createdBy: user._id });
}
async function updateTask(businessId, user, id, { action, assignedTo, note }) {
  const t = await HousekeepingTask.findOne({ _id: id, businessId }); if (!t) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND'); C.assertBranchAccess(user, t.branchId);
  const manage = C.can(user, 'accommodation.housekeeping.manage');
  if (action === 'assign') { C.requireCan(user, 'accommodation.housekeeping.manage'); const u = await User.findOne({ _id: assignedTo, businessId, status: 'active' }).select('name'); if (!u) throw ApiError.badRequest('Staff member not found', 'USER_NOT_FOUND'); t.assignedTo = u._id; t.assignedName = u.name; }
  else if (action === 'start') { if (t.assignedTo && String(t.assignedTo) !== String(user._id) && !manage) throw ApiError.forbidden('This task belongs to someone else', 'TASK_NOT_YOURS'); t.status = 'IN_PROGRESS'; t.startedAt = new Date(); t.assignedTo = t.assignedTo || user._id; t.assignedName = t.assignedName || user.name; if (['DEPARTURE_CLEAN', 'STAYOVER_CLEAN', 'DEEP_CLEAN'].includes(t.type)) await Room.updateOne({ _id: t.roomId, currentStayId: null }, { $set: { housekeeping: 'CLEANING' } }); }
  else if (action === 'complete') {
    if (t.assignedTo && String(t.assignedTo) !== String(user._id) && !manage) throw ApiError.forbidden('This task belongs to someone else', 'TASK_NOT_YOURS');
    t.status = 'DONE'; t.completedAt = new Date(); t.completedBy = user._id;
    if (['DEPARTURE_CLEAN', 'DEEP_CLEAN'].includes(t.type)) await Room.updateOne({ _id: t.roomId }, { $set: { housekeeping: 'CLEAN', lastCleanedAt: new Date() } });
    if (t.type === 'INSPECTION') { C.requireCan(user, 'accommodation.housekeeping.manage'); await Room.updateOne({ _id: t.roomId }, { $set: { housekeeping: 'INSPECTED', lastInspectedAt: new Date() } }); }
  } else if (action === 'cancel') { C.requireCan(user, 'accommodation.housekeeping.manage'); t.status = 'CANCELLED'; }
  if (note) t.note = note;
  await t.save(); return t;
}

module.exports = { getSettings, updateSettings, listRoomTypes, createRoomType, updateRoomType, createRoom, bulkCreateRooms, updateRoom, setStatus, setHousekeeping, board, listTasks, createTask, updateTask };
