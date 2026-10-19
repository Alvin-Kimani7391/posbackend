/**
 * Stays: availability, booking, check-in, extending, moving rooms, cancelling, no-shows and check-out.
 * Check-in and check-out times, early / late fees, deposits and cancellation terms all come from the owner's
 * AccommodationSettings and are snapshotted onto the stay when it is booked.
 */
const crypto = require('crypto');
const Stay = require('../../models/Stay');
const Room = require('../../models/Room');
const RoomType = require('../../models/RoomType');
const RestaurantOrder = require('../../models/RestaurantOrder');
const ServiceCall = require('../../models/ServiceCall');
const HousekeepingTask = require('../../models/HousekeepingTask');
const Customer = require('../../models/Customer');
const CustomerLedger = require('../../models/CustomerLedger');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const GP = require('../../utils/guestPin');
const T = require('../../utils/hospitalityTime');
const R = require('../../utils/hospitalityRates');
const H = require('../../constants/hospitality');
const { createInvoiceSale } = require('../invoice-sale.helper');
const folio = require('./folio.service');
const C = require('./common');

const pe = (e) => (e && e.code && !(e instanceof ApiError) && /^[A-Z_]+$/.test(e.code) ? ApiError.badRequest(e.message, e.code) : e);
const pinHash = (stayId, pin) => crypto.createHash('sha256').update(`${stayId}:${pin}`).digest('hex');
const newPin = (len) => C.rand(len, '0123456789');
const hist = folio.hist;

// ---------------------------------------------------------------- availability
/** Instants during which a stay blocks its room. A checked-in guest who overstays keeps blocking until they leave. */
const blockEnd = (s, now = new Date()) => (s.status === 'CHECKED_IN' ? new Date(Math.max(s.expectedCheckOut, now)) : s.expectedCheckOut);

async function roomConflicts(businessId, roomId, from, to, { excludeStayId, session } = {}) {
  const f = { businessId, roomId, status: { $in: H.BLOCKING_STAY_STATUS }, expectedCheckIn: { $lt: to } };
  if (excludeStayId) f._id = { $ne: excludeStayId };
  const list = await C.withSession(Stay.find(f).select('stayNumber status expectedCheckIn expectedCheckOut guest.name'), session);
  return list.filter((s) => T.overlaps(from, to, s.expectedCheckIn, blockEnd(s)));
}

async function assertRoomFree(room, from, to, opts = {}) {
  if (!room.active) throw ApiError.badRequest(`Room ${room.number} is not in use`, 'ROOM_INACTIVE');
  if (room.status === 'OUT_OF_ORDER' && (!room.outOfOrder?.until || room.outOfOrder.until > from)) throw ApiError.conflict(`Room ${room.number} is out of order`, 'ROOM_OUT_OF_ORDER');
  const clash = await roomConflicts(room.businessId, room._id, from, to, opts);
  if (clash.length) throw ApiError.conflict(`Room ${room.number} is already booked for those dates (${clash[0].stayNumber})`, 'ROOM_NOT_AVAILABLE');
}

/** Rooms of a type (or all) that are free for the dates. Used by the booking screen. */
async function availability(businessId, user, { branchId, checkInDate, checkOutDate, roomTypeId, checkInTime, checkOutTime, adults = 1, children = 0, mealPlan = 'ROOM_ONLY' }) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getAccContext(businessId); C.assertAccommodation(ctx);
  const w = windowFor(ctx, { checkInDate, checkOutDate, checkInTime, checkOutTime });
  const rooms = await Room.find({ businessId, branchId, active: true, ...(roomTypeId ? { roomTypeId } : {}) }).sort({ number: 1 });
  const types = new Map((await RoomType.find({ businessId, active: true })).map((t) => [String(t._id), t]));
  const out = [];
  for (const r of rooms) {
    const t = types.get(String(r.roomTypeId)); if (!t) continue;
    try { await assertRoomFree(r, w.from, w.to); } catch (e) { continue; }
    let quote = null; try { quote = R.priceStay(t, { checkInDate, checkOutDate, adults, children, mealPlan }); } catch (e) { quote = { error: e.message }; }
    out.push({ roomId: r._id, number: r.number, floor: r.floor, housekeeping: r.housekeeping, roomTypeId: t._id, roomType: t.name, quote });
  }
  const byType = {};
  for (const o of out) { byType[o.roomType] = byType[o.roomType] || { roomTypeId: o.roomTypeId, roomType: o.roomType, available: 0, from: o.quote.total }; byType[o.roomType].available += 1; }
  return { checkInDate, checkOutDate, today: T.todayIn(ctx.timeZone), timeZone: ctx.timeZone, expectedCheckIn: w.from, expectedCheckOut: w.to, rooms: out, byType: Object.values(byType) };
}

function windowFor(ctx, { checkInDate, checkOutDate, checkInTime, checkOutTime, dayUse }) {
  const tz = ctx.timeZone; const s = ctx.acc;
  const inT = checkInTime || s.checkIn.time;
  if (dayUse) { const from = T.zonedToUtc(checkInDate, inT, tz); return { from, to: new Date(from.getTime() + s.stay.dayUse.hours * 3600000), inT, outT: T.fmtMin(T.toMin(inT) + s.stay.dayUse.hours * 60 > 1439 ? 1439 : T.toMin(inT) + s.stay.dayUse.hours * 60) }; }
  const outT = checkOutTime || s.checkOut.time;
  if (!T.ymdOk(checkInDate) || !T.ymdOk(checkOutDate) || checkOutDate <= checkInDate) throw ApiError.badRequest('Check-out must be after check-in', 'INVALID_DATES');
  return { from: T.zonedToUtc(checkInDate, inT, tz), to: T.zonedToUtc(checkOutDate, outT, tz), inT, outT };
}

// ---------------------------------------------------------------- booking
async function folioFor(ctx, businessId, room, roomType, pricing, userId, session) {
  const lines = [];
  for (const n of pricing.nightly) lines.push(await folio.makeLine(ctx, businessId, { type: 'ROOM', description: `Room ${room.number} - ${n.date} (${n.label})`, quantity: 1, unitPrice: n.amount, taxRate: roomType.taxRate ?? ctx.roomTaxRate, nightDate: n.date, source: 'AUTO', userId }, session));
  for (const e of pricing.extras) lines.push(await folio.makeLine(ctx, businessId, { type: e.type, description: e.description, quantity: e.quantity, unitPrice: e.unitPrice, taxRate: roomType.taxRate ?? ctx.roomTaxRate, source: 'AUTO', userId }, session));
  return lines;
}

async function reserve(businessId, user, input) {
  C.requireCan(user, 'accommodation.stays.create', 'Booking a room needs permission');
  if (input.clientRef) { const dup = await Stay.findOne({ businessId, clientRef: input.clientRef }); if (dup) return { stay: dup, replayed: true }; }
  let out; let issuedPin = null;
  try {
    out = await C.inTx(async (session) => {
      const ctx = await C.getAccContext(businessId, session); C.assertAccommodation(ctx);
      const s = ctx.acc; C.assertBranchAccess(user, input.branchId);
      const branch = await C.assertBranch(businessId, input.branchId, session);
      const dayUse = !!input.dayUse;
      if (dayUse && !s.stay.allowDayUse) throw ApiError.badRequest('Day-use bookings are not offered', 'DAY_USE_NOT_ALLOWED');
      const checkOutDate = dayUse ? input.checkInDate : input.checkOutDate;
      const w = windowFor(ctx, { ...input, checkOutDate, dayUse });
      const nights = dayUse ? 1 : T.diffDays(input.checkInDate, checkOutDate);
      if (!dayUse && (nights < s.stay.minNights || nights > s.stay.maxNights)) throw ApiError.badRequest(`Stays must be between ${s.stay.minNights} and ${s.stay.maxNights} nights`, 'STAY_LENGTH_NOT_ALLOWED');
      const today = T.todayIn(ctx.timeZone);
      if (input.checkInDate < today) throw ApiError.badRequest(`The check-in date (${input.checkInDate}) is before today (${today}) in the business time zone (${ctx.timeZone}). Pick ${today} or later, or check the time zone in Settings.`, 'DATE_IN_PAST');
      if (T.diffDays(today, input.checkInDate) > s.stay.maxAdvanceDays) throw ApiError.badRequest('That is further ahead than bookings are accepted', 'TOO_FAR_AHEAD');
      if (s.stay.requirePhone && !input.guest?.phone) throw ApiError.badRequest('A phone number is required for the guest', 'PHONE_REQUIRED');

      let room;
      if (input.roomId) room = await Room.findOne({ _id: input.roomId, businessId, branchId: input.branchId }).session(session);
      else {
        const candidates = await Room.find({ businessId, branchId: input.branchId, roomTypeId: input.roomTypeId, active: true }).sort({ number: 1 }).session(session);
        for (const r of candidates) { try { await assertRoomFree(r, w.from, w.to, { session }); room = r; break; } catch (e) { /* try the next room */ } }
        if (!room) throw ApiError.conflict('No room of that type is free for those dates', 'ROOM_NOT_AVAILABLE');
      }
      if (!room) throw ApiError.badRequest('Room not found', 'ROOM_NOT_FOUND');
      await Room.updateOne({ _id: room._id }, { $inc: { bookingSeq: 1 } }, { session });       // two bookings of one room at once now conflict instead of both succeeding
      await assertRoomFree(room, w.from, w.to, { session });
      const roomType = await RoomType.findOne({ _id: room.roomTypeId, businessId }).session(session);
      if (!roomType || !roomType.active) throw ApiError.badRequest('This room type is not in use', 'ROOM_TYPE_INACTIVE');

      let overrideNightly;
      if (input.rateOverride !== undefined && input.rateOverride !== null) {
        if (!s.stay.allowOverrideRate) throw ApiError.badRequest('Negotiated rates are switched off', 'RATE_OVERRIDE_DISABLED');
        C.requireCan(user, 'accommodation.stays.override_rate', 'Changing the room rate needs a manager');
        overrideNightly = input.rateOverride;
      }
      let pricing; try { pricing = R.priceStay(roomType, { checkInDate: input.checkInDate, checkOutDate, adults: input.adults || 1, children: input.children || 0, mealPlan: input.mealPlan, overrideNightly, dayUse, dayUsePercent: s.stay.dayUse.percentOfNightly }); } catch (e) { throw pe(e); }

      const seq = await nextSequence(businessId, `stay:branch:${input.branchId}`, session);
      let bookingCode; do { bookingCode = C.rand(6, C.CODE_ALPHABET); } while (await Stay.exists({ businessId, bookingCode }).session(session));
      const lines = await folioFor(ctx, businessId, room, roomType, pricing, user._id, session);
      const doc = {
        businessId, branchId: input.branchId, stayNumber: `STY-${branch.code || 'MAIN'}-${pad(seq, 5)}`, bookingCode, groupId: input.groupId, source: input.source || 'WALK_IN',
        roomId: room._id, roomNumber: room.number, roomTypeId: roomType._id, roomTypeName: roomType.name, guest: input.guest, customerId: input.customerId, adults: input.adults || 1, children: input.children || 0, otherGuests: input.otherGuests,
        mealPlan: input.mealPlan || 'ROOM_ONLY', specialRequests: input.specialRequests, notes: input.notes, checkInDate: input.checkInDate, checkOutDate, nights, dayUse, expectedCheckIn: w.from, expectedCheckOut: w.to,
        policy: { checkInTime: w.inT, checkOutTime: w.outT, timeZone: ctx.timeZone }, rate: { nightly: pricing.nightly.map((n) => ({ date: n.date, amount: n.amount, label: n.label })), overridden: overrideNightly !== undefined, overrideReason: input.rateOverrideReason, overrideBy: overrideNightly !== undefined ? user._id : undefined },
        folio: lines, clientRef: input.clientRef, createdBy: user._id, qrOrdersEnabled: true, history: [{ at: new Date(), action: 'stay.reserve', by: user._id }],
      };
      const [stay] = await Stay.create([doc], { session });
      await folio.rebuildLevies(stay, ctx, user._id, session);
      folio.recompute(stay);
      const roomNet = stay.folio.filter((l) => !l.voided && ['ROOM', 'EXTRA_PERSON'].includes(l.type)).reduce((a, l) => a + l.total, 0);
      stay.depositRequired = R.depositDue(s, { firstNightAmount: pricing.nightly[0].amount, total: roomNet });
      if (input.deposit) { C.requireCan(user, 'accommodation.folio.pay', 'Taking a deposit needs permission'); const shift = await folio.openShift(businessId, input.branchId, user._id, session); await folio.applyPayment({ businessId, stay, user, ctx, session, shift, kind: 'DEPOSIT', payment: input.deposit }); folio.recompute(stay); hist(stay, 'folio.deposit', user._id, `${input.deposit.method} ${input.deposit.amount}`); }
      if (ctx.acc.selfService.guestPinRequired) { issuedPin = newPin(ctx.acc.selfService.guestPinLength); stay.guestPinHash = pinHash(stay._id, issuedPin); stay.guestPinEnc = GP.encrypt(issuedPin); }   // the guest's room PIN is issued with the booking and printed on the confirmation
      await stay.save({ session });
      await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.stay.reserve', entityType: 'Stay', entityId: stay._id, newValue: { stayNumber: stay.stayNumber, room: room.number, from: input.checkInDate, to: checkOutDate } }, session);
      return stay;
    });
  } catch (err) {
    if (err.code === 11000 && input.clientRef) { const dup = await Stay.findOne({ businessId, clientRef: input.clientRef }); if (dup) return { stay: dup, replayed: true }; }
    throw pe(err);
  }
  return { stay: out, replayed: false, pin: issuedPin };
}

// ---------------------------------------------------------------- check-in
function earlyFeeFor(ctx, stay, now) {
  const here = T.localDateTime(now, ctx.timeZone);
  if (here.ymd !== stay.checkInDate) return { applies: false, fee: 0 };
  const standardMin = T.toMin(stay.policy.checkInTime);
  return R.earlyCheckInFee(ctx.acc, { arrivalMin: here.minutes, standardMin, nightAmount: stay.rate.nightly[0]?.amount || 0 });
}

async function checkIn(businessId, user, id, input = {}) {
  C.requireCan(user, 'accommodation.stays.checkin', 'Checking a guest in needs permission');
  const out = await C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session); C.assertAccommodation(ctx);
    const stay = await folio.loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (stay.status !== 'RESERVED') throw ApiError.conflict(`This stay is ${stay.status.toLowerCase().replace('_', ' ')}`, 'INVALID_STAY_STATE');
    const now = new Date(); const here = T.localDateTime(now, ctx.timeZone);
    if (here.ymd < stay.checkInDate) throw ApiError.conflict(`This guest arrives on ${stay.checkInDate}. Change the booking dates first.`, 'TOO_EARLY');
    if (input.guest) Object.assign(stay.guest, input.guest);
    if (input.adults) stay.adults = input.adults; if (input.children !== undefined) stay.children = input.children; if (input.otherGuests) stay.otherGuests = input.otherGuests;
    if (ctx.acc.stay.requireIdAtCheckIn && (!stay.guest.idType || !stay.guest.idNumber)) throw ApiError.badRequest('Record the guest\'s ID or passport number to check in', 'ID_REQUIRED');
    folio.recompute(stay);
    const deposits = stay.payments.filter((p) => p.kind === 'DEPOSIT').reduce((s, p) => s + p.amount, 0);
    if (ctx.acc.deposit.requiredBeforeCheckIn && deposits < stay.depositRequired) throw ApiError.conflict('The deposit has not been paid yet', 'DEPOSIT_REQUIRED');

    let room = await Room.findOne({ _id: input.roomId || stay.roomId, businessId, branchId: stay.branchId }).session(session);
    if (!room) throw ApiError.badRequest('Room not found', 'ROOM_NOT_FOUND');
    if (input.roomId && String(input.roomId) !== String(stay.roomId)) { await assertRoomFree(room, stay.expectedCheckIn, stay.expectedCheckOut, { excludeStayId: stay._id, session }); await moveFolioRoom(stay, room, ctx, user, session); }
    const ready = room.status === 'AVAILABLE' && ['CLEAN', 'INSPECTED'].includes(room.housekeeping) && (!ctx.acc.housekeeping.requireInspection || room.housekeeping === 'INSPECTED');
    if (!ready && !(input.force && C.can(user, 'accommodation.stays.manage'))) throw ApiError.conflict(`Room ${room.number} is not ready (${room.status === 'AVAILABLE' ? room.housekeeping.toLowerCase() : room.status.toLowerCase().replace('_', ' ')})`, 'ROOM_NOT_READY');

    const early = earlyFeeFor(ctx, stay, now);
    if (early.denied && !input.waiveEarlyFee) throw ApiError.conflict(early.label || 'Too early to check in', 'EARLY_CHECKIN_NOT_ALLOWED');
    if (early.applies && early.fee > 0 && !early.denied) {
      if (input.waiveEarlyFee) C.requireCan(user, 'accommodation.stays.waive_fees', 'Waiving the early check-in fee needs a manager');
      else stay.folio.push(await folio.makeLine(ctx, businessId, { type: 'EARLY_CHECKIN', description: early.label, quantity: 1, unitPrice: early.fee, taxRate: ctx.roomTaxRate, source: 'POLICY', userId: user._id }, session));
    }
    const claimed = await Room.findOneAndUpdate({ _id: room._id, currentStayId: null, status: room.status === 'AVAILABLE' ? 'AVAILABLE' : room.status }, { $set: { status: 'OCCUPIED', currentStayId: stay._id } }, { new: true, session });
    if (!claimed) throw ApiError.conflict(`Room ${room.number} is occupied`, 'ROOM_OCCUPIED');
    let pin = null;
    if (ctx.acc.selfService.guestPinRequired) {
      const prev = await Stay.findById(stay._id).select('+guestPinEnc +guestPinHash').session(session);
      pin = prev && prev.guestPinEnc && prev.guestPinHash ? GP.decrypt(prev.guestPinEnc) : null;      // the PIN printed at booking stays valid
      if (!pin) { pin = newPin(ctx.acc.selfService.guestPinLength); stay.guestPinEnc = GP.encrypt(pin); }
      stay.guestPinHash = pinHash(stay._id, pin);
    }
    stay.pinFailures = 0; stay.pinLockedUntil = undefined;
    stay.status = 'CHECKED_IN'; stay.actualCheckIn = now;
    await rebuildLeviesIfNeeded(stay, ctx, user._id, session);
    folio.recompute(stay); hist(stay, 'stay.check_in', user._id, input.selfService ? 'self check-in' : undefined); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.stay.check_in', entityType: 'Stay', entityId: stay._id, newValue: { room: stay.roomNumber, early: early.fee || 0 } }, session);
    return { stay, pin, earlyFee: early.applies ? early.fee : 0 };
  }).catch((e) => { throw pe(e); });
  return out;
}
async function rebuildLeviesIfNeeded(stay, ctx, userId, session) { if ((ctx.acc.tax?.levies || []).length) await folio.rebuildLevies(stay, ctx, userId, session); }

/** Changes the room on a stay: reprices the nights that are still ahead. */
async function moveFolioRoom(stay, newRoom, ctx, user, session) {
  const roomType = await RoomType.findOne({ _id: newRoom.roomTypeId, businessId: stay.businessId }).session(session);
  const today = T.todayIn(ctx.timeZone);
  const fromDate = stay.status === 'CHECKED_IN' && today > stay.checkInDate ? today : stay.checkInDate;
  const remaining = stay.folio.filter((l) => !l.voided && l.type === 'ROOM' && l.nightDate >= fromDate);
  const oldRooms = new Set(); for (const l of remaining) { l.voided = true; l.voidReason = `Moved to room ${newRoom.number}`; l.voidedAt = new Date(); l.voidedBy = user._id; oldRooms.add(l.nightDate); }
  const nights = [...oldRooms].sort();
  for (const date of nights) {
    const r = stay.rate.overridden ? { amount: stay.rate.nightly.find((n) => n.date === date)?.amount, label: 'Negotiated' } : R.nightRate(roomType, date);
    stay.folio.push(await folio.makeLine(ctx, stay.businessId, { type: 'ROOM', description: `Room ${newRoom.number} - ${date} (${r.label})`, quantity: 1, unitPrice: r.amount, taxRate: roomType.taxRate ?? ctx.roomTaxRate, nightDate: date, source: 'AUTO', userId: user._id }, session));
    const rn = stay.rate.nightly.find((n) => n.date === date); if (rn) { rn.amount = r.amount; rn.label = r.label; }
  }
  stay.roomId = newRoom._id; stay.roomNumber = newRoom.number; stay.roomTypeId = roomType._id; stay.roomTypeName = roomType.name;
  await folio.rebuildLevies(stay, ctx, user._id, session);
}

/** Moves an in-house or reserved guest to another room. */
async function moveRoom(businessId, user, id, { roomId, reason }) {
  C.requireCan(user, 'accommodation.stays.manage', 'Moving a guest needs permission');
  return C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await folio.loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is closed', 'STAY_CLOSED');
    if (String(stay.roomId) === String(roomId)) throw ApiError.badRequest('Already in that room', 'SAME_ROOM');
    const room = await Room.findOne({ _id: roomId, businessId, branchId: stay.branchId }).session(session); if (!room) throw ApiError.badRequest('Room not found', 'ROOM_NOT_FOUND');
    await Room.updateOne({ _id: room._id }, { $inc: { bookingSeq: 1 } }, { session });
    await assertRoomFree(room, stay.expectedCheckIn, stay.expectedCheckOut, { excludeStayId: stay._id, session });
    const oldRoomId = stay.roomId; const oldNumber = stay.roomNumber;
    if (stay.status === 'CHECKED_IN') {
      if (room.status !== 'AVAILABLE' || !['CLEAN', 'INSPECTED'].includes(room.housekeeping)) throw ApiError.conflict(`Room ${room.number} is not ready`, 'ROOM_NOT_READY');
      const claimed = await Room.findOneAndUpdate({ _id: room._id, currentStayId: null, status: 'AVAILABLE' }, { $set: { status: 'OCCUPIED', currentStayId: stay._id } }, { new: true, session });
      if (!claimed) throw ApiError.conflict(`Room ${room.number} is occupied`, 'ROOM_OCCUPIED');
      await Room.updateOne({ _id: oldRoomId }, { $set: { status: 'AVAILABLE', housekeeping: 'DIRTY', currentStayId: null } }, { session });
      await HousekeepingTask.create([{ businessId, branchId: stay.branchId, roomId: oldRoomId, roomNumber: oldNumber, type: 'DEPARTURE_CLEAN', note: `Guest moved to ${room.number}`, auto: true, createdBy: user._id }], { session });
    }
    await moveFolioRoom(stay, room, ctx, user, session);
    if (stay.status === 'CHECKED_IN' && ctx.acc.selfService.guestPinRequired) stay.pinFailures = 0;
    folio.recompute(stay); hist(stay, 'stay.move_room', user._id, `${oldNumber} -> ${room.number}${reason ? `: ${reason}` : ''}`); stay.version += 1; await stay.save({ session });
    await RestaurantOrder.updateMany({ businessId, stayId: stay._id, status: 'OPEN' }, { $set: { roomId: room._id, roomNumber: room.number } }, { session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.stay.move_room', entityType: 'Stay', entityId: stay._id, newValue: { from: oldNumber, to: room.number, reason } }, session);
    return stay;
  }).catch((e) => { throw pe(e); });
}

/** Changes the check-out date (extend or shorten). New nights are priced at the room's current rates. */
async function changeDates(businessId, user, id, { checkOutDate, checkInDate, reason }) {
  C.requireCan(user, 'accommodation.stays.manage', 'Changing dates needs permission');
  return C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await folio.loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is closed', 'STAY_CLOSED');
    if (stay.dayUse) throw ApiError.badRequest('A day-use booking has no nights to change', 'DAY_USE');
    const newIn = stay.status === 'CHECKED_IN' ? stay.checkInDate : (checkInDate || stay.checkInDate);
    const newOut = checkOutDate || stay.checkOutDate;
    const w = windowFor(ctx, { checkInDate: newIn, checkOutDate: newOut, checkInTime: stay.policy.checkInTime, checkOutTime: stay.policy.checkOutTime });
    const nights = T.diffDays(newIn, newOut);
    if (nights < ctx.acc.stay.minNights || nights > ctx.acc.stay.maxNights) throw ApiError.badRequest(`Stays must be between ${ctx.acc.stay.minNights} and ${ctx.acc.stay.maxNights} nights`, 'STAY_LENGTH_NOT_ALLOWED');
    if (stay.status === 'RESERVED' && newIn < T.todayIn(ctx.timeZone)) throw ApiError.badRequest(`The check-in date (${newIn}) is before today (${T.todayIn(ctx.timeZone)}) in the business time zone (${ctx.timeZone}).`, 'DATE_IN_PAST');
    const room = await Room.findOne({ _id: stay.roomId, businessId }).session(session);
    await Room.updateOne({ _id: room._id }, { $inc: { bookingSeq: 1 } }, { session });
    await assertRoomFree(room, w.from, w.to, { excludeStayId: stay._id, session });
    const roomType = await RoomType.findOne({ _id: room.roomTypeId, businessId }).session(session);
    const wanted = T.eachNight(newIn, newOut); const have = new Set(stay.folio.filter((l) => !l.voided && l.type === 'ROOM').map((l) => l.nightDate));
    for (const l of stay.folio) if (!l.voided && l.type === 'ROOM' && !wanted.includes(l.nightDate)) { l.voided = true; l.voidReason = `Dates changed${reason ? `: ${reason}` : ''}`; l.voidedAt = new Date(); l.voidedBy = user._id; }
    for (const date of wanted.filter((d) => !have.has(d))) {
      const base = stay.rate.overridden ? { amount: stay.rate.nightly[stay.rate.nightly.length - 1]?.amount ?? roomType.baseRate, label: 'Negotiated' } : R.nightRate(roomType, date);
      stay.folio.push(await folio.makeLine(ctx, businessId, { type: 'ROOM', description: `Room ${room.number} - ${date} (${base.label})`, quantity: 1, unitPrice: base.amount, taxRate: roomType.taxRate ?? ctx.roomTaxRate, nightDate: date, source: 'AUTO', userId: user._id }, session));
    }
    stay.rate.nightly = wanted.map((d) => { const l = stay.folio.find((x) => !x.voided && x.type === 'ROOM' && x.nightDate === d); return { date: d, amount: l.unitPrice, label: l.description.match(/\(([^)]*)\)$/)?.[1] || 'Standard' }; });
    stay.checkInDate = newIn; stay.checkOutDate = newOut; stay.nights = nights; stay.expectedCheckIn = w.from; stay.expectedCheckOut = w.to;
    await folio.rebuildLevies(stay, ctx, user._id, session); folio.recompute(stay);
    hist(stay, 'stay.change_dates', user._id, `${newIn} -> ${newOut}${reason ? `: ${reason}` : ''}`); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.stay.change_dates', entityType: 'Stay', entityId: stay._id, newValue: { checkInDate: newIn, checkOutDate: newOut, reason } }, session);
    return stay;
  }).catch((e) => { throw pe(e); });
}

async function updateStay(businessId, user, id, input) {
  C.requireCan(user, 'accommodation.stays.manage', 'Editing a stay needs permission');
  const stay = await folio.loadStay(businessId, id); C.assertBranchAccess(user, stay.branchId);
  if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is closed', 'STAY_CLOSED');
  if (input.guest) Object.assign(stay.guest, input.guest);
  for (const k of ['notes', 'specialRequests', 'otherGuests', 'adults', 'children', 'qrOrdersEnabled', 'customerId']) if (input[k] !== undefined) stay[k] = input[k];
  hist(stay, 'stay.update', user._id); stay.version += 1; await stay.save(); return stay;
}

// ---------------------------------------------------------------- cancel / no-show
async function cancel(businessId, user, id, { reason, waiveFee }) {
  C.requireCan(user, 'accommodation.stays.manage', 'Cancelling a booking needs permission');
  return C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await folio.loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (stay.status !== 'RESERVED') throw ApiError.conflict('Only a booking that has not arrived can be cancelled', 'INVALID_STAY_STATE');
    const rooms = stay.folio.filter((l) => !l.voided && ['ROOM', 'EXTRA_PERSON'].includes(l.type)).reduce((a, l) => a + l.total, 0);
    const c = R.cancellationFee(ctx.acc, { expectedCheckIn: stay.expectedCheckIn, firstNightAmount: stay.rate.nightly[0]?.amount || 0, total: rooms });
    let fee = c.fee; if (fee > 0 && waiveFee) { C.requireCan(user, 'accommodation.stays.waive_fees', 'Waiving the cancellation fee needs a manager'); fee = 0; }
    for (const l of stay.folio) if (!l.voided) { l.voided = true; l.voidReason = 'Booking cancelled'; l.voidedAt = new Date(); l.voidedBy = user._id; }
    if (fee > 0) stay.folio.push(await folio.makeLine(ctx, businessId, { type: 'CANCELLATION', description: 'Late cancellation fee', quantity: 1, unitPrice: fee, taxRate: 0, source: 'POLICY', userId: user._id }, session));
    stay.status = 'CANCELLED'; stay.cancellation = { at: new Date(), by: user._id, reason, fee };
    folio.recompute(stay); hist(stay, 'stay.cancel', user._id, reason); stay.version += 1; await stay.save({ session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.stay.cancel', entityType: 'Stay', entityId: stay._id, newValue: { reason, fee } }, session);
    return { stay, fee, balance: stay.totals.balance };
  });
}

/** A booking whose guest never arrived. Charges the same penalty as a late cancellation unless waived. */
async function markNoShow(businessId, user, id, { reason, waiveFee } = {}, { auto = false } = {}) {
  if (!auto) C.requireCan(user, 'accommodation.stays.manage', 'Marking a no-show needs permission');
  return C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session);
    const stay = await folio.loadStay(businessId, id, session); if (!auto) C.assertBranchAccess(user, stay.branchId);
    if (stay.status !== 'RESERVED') throw ApiError.conflict('Only a booking that has not arrived can be a no-show', 'INVALID_STAY_STATE');
    const releaseAt = new Date(stay.expectedCheckIn.getTime() + ctx.acc.noShow.afterHours * 3600000);
    if (new Date() < releaseAt && !C.can(user, 'accommodation.stays.manage')) throw ApiError.conflict('It is too early to release this booking', 'TOO_EARLY_FOR_NO_SHOW');
    const rooms = stay.folio.filter((l) => !l.voided && ['ROOM', 'EXTRA_PERSON'].includes(l.type)).reduce((a, l) => a + l.total, 0);
    const first = stay.rate.nightly[0]?.amount || 0;
    let fee = ctx.acc.noShow.chargePenalty ? R.cancellationFee(ctx.acc, { expectedCheckIn: stay.expectedCheckIn, now: new Date(stay.expectedCheckIn.getTime() + 3600000), firstNightAmount: first, total: rooms }).fee : 0;
    if (fee > 0 && waiveFee) { C.requireCan(user, 'accommodation.stays.waive_fees'); fee = 0; }
    for (const l of stay.folio) if (!l.voided) { l.voided = true; l.voidReason = 'No-show'; l.voidedAt = new Date(); }
    if (fee > 0) stay.folio.push(await folio.makeLine(ctx, businessId, { type: 'NO_SHOW', description: 'No-show charge', quantity: 1, unitPrice: fee, taxRate: 0, source: 'POLICY', userId: user?._id }, session));
    stay.status = 'NO_SHOW'; stay.noShowAt = new Date(); stay.cancellation = { at: new Date(), by: user?._id, reason: reason || 'No-show', fee };
    folio.recompute(stay); hist(stay, 'stay.no_show', user?._id, reason); stay.version += 1; await stay.save({ session });
    return { stay, fee };
  });
}

// ---------------------------------------------------------------- check-out
/** What leaving right now would add to the folio. Pure read: nothing is saved. */
async function checkoutQuote(businessId, user, id, { at } = {}) {
  const ctx = await C.getAccContext(businessId);
  const stay = await folio.loadStay(businessId, id); C.assertBranchAccess(user, stay.branchId);
  return computeDeparture(ctx, stay, at ? new Date(at) : new Date());
}

function computeDeparture(ctx, stay, now) {
  const here = T.localDateTime(now, ctx.timeZone);
  const adds = []; const voids = []; const notes = [];
  const lastNight = stay.rate.nightly[stay.rate.nightly.length - 1]?.amount || 0;
  const standardMin = T.toMin(stay.policy.checkOutTime);
  if (stay.dayUse) {
    const over = now - stay.expectedCheckOut;
    if (over > ctx.acc.lateCheckOut.graceMinutes * 60000) { const f = R.lateCheckOutFee(ctx.acc, { departMin: standardMin + Math.ceil(over / 60000), standardMin, nightAmount: stay.rate.nightly[0]?.amount || 0 }); if (f.fee) adds.push({ type: 'LATE_CHECKOUT', description: f.label, unitPrice: f.fee }); }
    return { here, adds, voids, notes, denied: false };
  }
  if (here.ymd > stay.checkOutDate) {                                  // stayed past the booked date: each extra night is charged
    for (let d = stay.checkOutDate; d < here.ymd; d = T.addDays(d, 1)) adds.push({ type: 'ROOM', description: `Extra night ${d}`, unitPrice: lastNight, nightDate: d, extraNight: true });
    notes.push(`Stayed ${T.diffDays(stay.checkOutDate, here.ymd)} night(s) past the booked date`);
    const f = R.lateCheckOutFee(ctx.acc, { departMin: here.minutes, standardMin, nightAmount: lastNight });
    if (f.fee && !f.denied) adds.push({ type: 'LATE_CHECKOUT', description: f.label, unitPrice: f.fee });
  } else if (here.ymd === stay.checkOutDate) {
    const f = R.lateCheckOutFee(ctx.acc, { departMin: here.minutes, standardMin, nightAmount: lastNight });
    if (f.fee) { adds.push({ type: 'LATE_CHECKOUT', description: f.label, unitPrice: f.fee }); notes.push(f.label); }
  } else if (ctx.acc.stay.earlyDeparture === 'CHARGE_USED') {          // left early: nights not slept are removed
    for (const l of stay.folio) if (!l.voided && l.type === 'ROOM' && l.nightDate >= here.ymd) voids.push(l._id);
    notes.push('Left before the booked date: unused nights are not charged');
  }
  return { here, adds, voids, notes, denied: false };
}

async function checkOut(businessId, user, id, input = {}) {
  C.requireCan(user, 'accommodation.stays.checkout', 'Checking a guest out needs permission');
  const out = await C.inTx(async (session) => {
    const ctx = await C.getAccContext(businessId, session); C.assertAccommodation(ctx);
    const stay = await folio.loadStay(businessId, id, session); C.assertBranchAccess(user, stay.branchId);
    if (stay.status !== 'CHECKED_IN') throw ApiError.conflict(`This stay is ${stay.status.toLowerCase().replace('_', ' ')}`, 'INVALID_STAY_STATE');
    const open = await RestaurantOrder.find({ businessId, stayId: stay._id, status: 'OPEN' }).select('orderNumber billStatus').session(session);
    if (open.length) throw ApiError.conflict(`Room orders still open: ${open.map((o) => o.orderNumber).join(', ')}. Serve and charge them to the room first.`, 'ROOM_ORDERS_OPEN');
    const now = new Date();
    const dep = computeDeparture(ctx, stay, now);
    for (const lid of dep.voids) { const l = stay.folio.id(lid); l.voided = true; l.voidReason = 'Left early'; l.voidedAt = now; l.voidedBy = user._id; }
    for (const a of dep.adds) {
      if (a.type === 'LATE_CHECKOUT' && input.waiveLateFee) { C.requireCan(user, 'accommodation.stays.waive_fees', 'Waiving the late check-out fee needs a manager'); continue; }
      stay.folio.push(await folio.makeLine(ctx, businessId, { type: a.type, description: a.description, quantity: 1, unitPrice: a.unitPrice, taxRate: ctx.roomTaxRate, nightDate: a.nightDate, source: a.type === 'ROOM' ? 'AUTO' : 'POLICY', userId: user._id }, session));
    }
    await folio.rebuildLevies(stay, ctx, user._id, session);
    folio.recompute(stay);
    const shift = await folio.openShift(businessId, stay.branchId, user._id, session);
    let change = 0;
    for (const p of input.payments || []) {
      folio.recompute(stay);
      if (p.method !== 'CREDIT' && p.amount > Math.max(0, stay.totals.balance)) throw ApiError.badRequest('Payment is more than the balance owing', 'OVERPAYMENT');
      if (p.method === 'CREDIT' && p.amount > stay.totals.balance) throw ApiError.badRequest('Credit is more than the balance owing', 'OVERPAYMENT');
      const pay = await folio.applyPayment({ businessId, stay, user, ctx, session, shift, kind: 'PAYMENT', payment: p, customerId: input.customerId });
      if (pay?.changeGiven) change += pay.changeGiven;
    }
    folio.recompute(stay);
    if (stay.totals.balance > 0) {
      C.requireCan(user, 'accommodation.folio.close_unpaid', 'Checking out with money still owing needs a manager');
      if (!input.closeUnpaidReason || input.closeUnpaidReason.trim().length < 3) throw ApiError.badRequest(`The guest still owes ${(stay.totals.balance / 100).toFixed(2)}. Take payment or give a reason to write it off.`, 'BALANCE_OWING');
      stay.closeUnpaid = { amount: stay.totals.balance, reason: input.closeUnpaidReason, by: user._id }; folio.recompute(stay);
    }
    if (stay.totals.balance < 0) throw ApiError.conflict('The guest has paid more than the folio. Refund the difference first.', 'OVERPAID');

    const sale = await invoiceStay({ ctx, stay, user, session, shift });
    stay.status = 'CHECKED_OUT'; stay.actualCheckOut = now; stay.guestPinHash = undefined; stay.guestPinEnc = undefined;
    hist(stay, 'stay.check_out', user._id, input.selfService ? 'self check-out' : undefined); stay.version += 1; await stay.save({ session });
    await Room.updateOne({ _id: stay.roomId }, { $set: { status: 'AVAILABLE', housekeeping: 'DIRTY', currentStayId: null } }, { session });
    if (ctx.acc.housekeeping.autoCreateTasks) await HousekeepingTask.create([{ businessId, branchId: stay.branchId, roomId: stay.roomId, roomNumber: stay.roomNumber, type: 'DEPARTURE_CLEAN', stayId: stay._id, auto: true, createdBy: user._id, priority: await nextArrivalSoon(businessId, stay, session) ? 'URGENT' : 'NORMAL' }], { session });
    await ServiceCall.updateMany({ businessId, roomId: stay.roomId, status: { $in: ['OPEN', 'ACKNOWLEDGED'] } }, { $set: { status: 'RESOLVED', resolvedAt: now, resolvedBy: user._id } }, { session });
    await C.audit({ businessId, branchId: stay.branchId, userId: user._id, action: 'accommodation.stay.check_out', entityType: 'Stay', entityId: stay._id, newValue: { total: stay.totals.charges, waived: stay.totals.waived, sale: sale?.receiptNumber } }, session);
    return { stay, sale, change, notes: dep.notes };
  }).catch((e) => { throw pe(e); });
  afterInvoice(businessId, out.sale);
  if (out.stay.totals.waived > 0) C.notifyManagement(businessId, { type: 'RESTAURANT_VOID', title: `Stay closed unpaid: ${out.stay.stayNumber}`, message: `${user.name} checked out ${out.stay.guest.name} with ${(out.stay.totals.waived / 100).toFixed(2)} unpaid: ${out.stay.closeUnpaid?.reason}`, branchId: out.stay.branchId, entityType: 'Stay', entityId: out.stay._id });
  return out;
}

async function nextArrivalSoon(businessId, stay, session) {
  const soon = new Date(Date.now() + 8 * 3600000);
  return !!(await Stay.exists({ businessId, roomId: stay.roomId, status: 'RESERVED', expectedCheckIn: { $lte: soon } }).session(session));
}

/** Folio -> one Sale + Receipt (+ eTIMS in Kenya). Credit portions go on the customer's account. Returns null when nothing is owed. */
async function invoiceStay({ ctx, stay, user, session, shift }) {
  const live = stay.folio.filter((l) => !l.voided && l.total !== 0);
  const effective = live.reduce((s, l) => s + l.total, 0) - (stay.totals.waived || 0);
  if (!live.length || effective <= 0) return null;
  const items = live.map((l) => ({ productId: l.productId, nameSnapshot: l.description, skuSnapshot: l.sku || 'ACCOMMODATION', quantity: l.quantity, unitPrice: l.unitPrice, costPriceSnapshot: l.quantity ? Math.round((l.cost || 0) / l.quantity) : 0, discount: 0, taxRate: l.taxRate, taxAmount: l.taxAmount, total: l.total, refundedQuantity: 0, serialNumbers: [] }));
  const paid = stay.totals.paid; const credit = stay.totals.credit;
  const customer = stay.customerId ? await Customer.findById(stay.customerId).session(session) : null;
  const payments = stay.payments.filter((p) => p.kind !== 'REFUND').map((p) => ({ method: p.method, amount: p.amount, reference: p.reference }));
  const sale = await createInvoiceSale({
    business: ctx.business, branchId: stay.branchId, user, session, customer: customer || { name: stay.guest.name, phone: stay.guest.phone },
    items, totals: { subtotal: live.reduce((s, l) => s + l.gross, 0), itemDiscount: 0, tax: live.reduce((s, l) => s + l.taxAmount, 0), total: effective }, payments, source: 'ACCOMMODATION',
    links: { stayId: stay._id }, notes: `Stay ${stay.stayNumber} · Room ${stay.roomNumber} · ${stay.checkInDate} to ${stay.checkOutDate}${stay.totals.waived ? ' (balance written off)' : ''}`,
    extraReceiptLines: [`Guest: ${stay.guest.name}`, `Room ${stay.roomNumber} · ${stay.nights} night(s)`, `Stay ${stay.stayNumber}`], paid, balance: credit,
  });
  stay.saleId = sale._id; stay.receiptNumber = sale.receiptNumber; stay.invoiceNumber = sale.invoiceNumber;
  const Payment = require('../../models/Payment');
  await Payment.updateMany({ businessId: stay.businessId, stayId: stay._id }, { $set: { saleId: sale._id } }, { session });
  if (credit > 0) {
    const cust = await Customer.findOne({ _id: stay.creditCustomerId, businessId: stay.businessId }).session(session);
    const nb = cust.outstandingBalance + credit;
    await CustomerLedger.create([{ businessId: stay.businessId, customerId: cust._id, transactionType: 'SALE_CREDIT', referenceType: 'Sale', referenceId: sale._id, debit: credit, credit: 0, balance: nb, createdBy: user._id }], { session });
    await Customer.updateOne({ _id: cust._id }, { $inc: { outstandingBalance: credit } }, { session });
  }
  return sale;
}
function afterInvoice(businessId, sale) {
  if (!sale) return;
  try { require('../crm.service').onSaleCompleted(businessId, sale._id); } catch (e) { console.error('[crm] capture hook failed', e.message); }
  try { require('../etims.service').kickForSale(businessId, sale._id); } catch (e) { console.error('[etims] kick failed', e.message); }
}

// ---------------------------------------------------------------- guest PIN
async function verifyPin(stayId, pin) {
  const s = await Stay.findById(stayId).select('+guestPinHash status pinFailures pinLockedUntil businessId');
  if (!s || s.status !== 'CHECKED_IN') return false;
  if (!s.guestPinHash) return true;                                     // this business does not use PINs
  if (s.pinLockedUntil && s.pinLockedUntil > new Date()) throw ApiError.forbidden('Too many wrong codes. Ask reception.', 'PIN_LOCKED');
  const ok = !!pin && crypto.timingSafeEqual(Buffer.from(pinHash(s._id, String(pin))), Buffer.from(s.guestPinHash));
  if (ok) { if (s.pinFailures) await Stay.updateOne({ _id: s._id }, { $set: { pinFailures: 0 } }); return true; }
  const failures = (s.pinFailures || 0) + 1;
  await Stay.updateOne({ _id: s._id }, { $set: failures >= 5 ? { pinFailures: 0, pinLockedUntil: new Date(Date.now() + 15 * 60000) } : { pinFailures: failures } });
  return false;
}
/** Reception issues a fresh PIN (guest forgot it). Returned once. */
async function resetPin(businessId, user, id) {
  C.requireCan(user, 'accommodation.stays.manage');
  const ctx = await C.getAccContext(businessId);
  const stay = await folio.loadStay(businessId, id); C.assertBranchAccess(user, stay.branchId);
  if (stay.status !== 'CHECKED_IN') throw ApiError.conflict('The guest is not checked in', 'INVALID_STAY_STATE');
  const pin = newPin(ctx.acc.selfService.guestPinLength); stay.guestPinHash = pinHash(stay._id, pin); stay.guestPinEnc = GP.encrypt(pin); stay.pinFailures = 0; stay.pinLockedUntil = undefined; hist(stay, 'stay.pin_reset', user._id); await stay.save();
  return { pin };
}
/** Reception reprints the guest card: shows the PIN again (issues one if this stay has none yet). Booked or checked-in stays only. */
async function guestCard(businessId, user, id) {
  C.requireCan(user, 'accommodation.stays.checkin', 'Printing the guest card needs permission');
  const ctx = await C.getAccContext(businessId);
  const stay = await Stay.findOne({ _id: id, businessId }).select('+guestPinEnc +guestPinHash'); if (!stay) throw ApiError.notFound('Stay not found', 'STAY_NOT_FOUND'); C.assertBranchAccess(user, stay.branchId);
  if (!['RESERVED', 'CHECKED_IN'].includes(stay.status)) throw ApiError.conflict('This stay is closed', 'INVALID_STAY_STATE');
  if (!ctx.acc.selfService.guestPinRequired) return { pin: null, required: false };
  let pin = stay.guestPinEnc && stay.guestPinHash ? GP.decrypt(stay.guestPinEnc) : null;
  if (!pin) { pin = newPin(ctx.acc.selfService.guestPinLength); stay.guestPinHash = pinHash(stay._id, pin); stay.guestPinEnc = GP.encrypt(pin); stay.pinFailures = 0; stay.pinLockedUntil = undefined; hist(stay, 'stay.pin_issued', user._id); await stay.save(); }
  return { pin, required: true };
}

// ---------------------------------------------------------------- lookups
/** The room + checked-in stay a room-service order belongs to (used by createOrder). */
async function resolveRoomForOrder(businessId, branchId, { roomId, stayId }, session) {
  const ctx = await C.getAccContext(businessId, session); C.assertAccommodation(ctx);
  if (!ctx.acc.roomService.enabled) throw ApiError.badRequest('Room service is switched off', 'ROOM_SERVICE_DISABLED');
  let stay;
  if (stayId) stay = await C.withSession(Stay.findOne({ _id: stayId, businessId }), session);
  else if (roomId) { const room = await C.withSession(Room.findOne({ _id: roomId, businessId }), session); if (room?.currentStayId) stay = await C.withSession(Stay.findOne({ _id: room.currentStayId, businessId }), session); }
  else throw ApiError.badRequest('Choose the room', 'ROOM_REQUIRED');
  if (!stay || stay.status !== 'CHECKED_IN') throw ApiError.conflict('That room has no checked-in guest', 'STAY_NOT_CHECKED_IN');
  if (String(stay.branchId) !== String(branchId)) throw ApiError.badRequest('Room belongs to another branch', 'BRANCH_MISMATCH');
  const room = await C.withSession(Room.findOne({ _id: stay.roomId, businessId }), session);
  const rs = ctx.acc.roomService;
  if (rs.hoursStart && rs.hoursEnd) {
    const m = T.localDateTime(new Date(), ctx.timeZone).minutes; const a = T.toMin(rs.hoursStart); const b = T.toMin(rs.hoursEnd);
    const open = a <= b ? (m >= a && m < b) : (m >= a || m < b);
    if (!open) throw ApiError.conflict(`Room service is available ${rs.hoursStart} to ${rs.hoursEnd}`, 'ROOM_SERVICE_CLOSED');
  }
  return { room, stay };
}

async function getStay(businessId, user, id) {
  const stay = await folio.loadStay(businessId, id); C.assertBranchAccess(user, stay.branchId);
  const [orders, room] = await Promise.all([RestaurantOrder.find({ businessId, stayId: stay._id }).select('orderNumber status billStatus totals createdAt items.name items.quantity items.status').sort({ createdAt: -1 }), Room.findById(stay.roomId).select('number floor status housekeeping')]);
  return { stay, orders, room };
}

async function listStays(businessId, user, q) {
  const { branchId, status, roomId, search, from, to, arriving, departing, page = 1, limit = 20 } = q;
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (status) f.status = { $in: String(status).split(',') };
  if (roomId) f.roomId = roomId;
  if (from || to) { f.expectedCheckIn = {}; if (from) f.expectedCheckIn.$gte = new Date(from); if (to) f.expectedCheckIn.$lte = new Date(to); }
  const ctx = await C.getAccContext(businessId); const today = T.todayIn(ctx.timeZone);
  if (arriving) { f.checkInDate = today; f.status = 'RESERVED'; }
  if (departing) { f.checkOutDate = { $lte: today }; f.status = 'CHECKED_IN'; }
  if (search) { const rx = new RegExp(C.escapeRegex(search), 'i'); f.$or = [{ stayNumber: rx }, { bookingCode: rx }, { 'guest.name': rx }, { 'guest.phone': rx }, { roomNumber: rx }]; }
  const [items, total] = await Promise.all([Stay.find(f).select('-history -folio').sort({ expectedCheckIn: arriving ? 1 : -1 }).skip((page - 1) * limit).limit(limit), Stay.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

module.exports = {
  availability, reserve, checkIn, moveRoom, changeDates, updateStay, cancel, markNoShow, checkoutQuote, checkOut, computeDeparture, verifyPin, resetPin, guestCard,
  resolveRoomForOrder, getStay, listStays, assertRoomFree, roomConflicts, windowFor, blockEnd, earlyFeeFor,
};
