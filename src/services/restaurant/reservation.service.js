/** Reservations, waiting list and deposits. A booking blocks its tables for its time window; the order created from it links back. */
const Reservation = require('../../models/Reservation');
const RestaurantTable = require('../../models/RestaurantTable');
const RestaurantOrder = require('../../models/RestaurantOrder');
const Payment = require('../../models/Payment');
const CashShift = require('../../models/CashShift');
const Customer = require('../../models/Customer');
const ApiError = require('../../utils/ApiError');
const { nextSequence, pad } = require('../../models/Counter');
const { RESERVATION_ACTIVE } = require('../../constants/restaurant');
const C = require('./common');
const billSvc = require('./bill.service');

async function checkTables(businessId, branchId, tableIds, partySize, startsAt, endsAt, excludeId, session, force) {
  if (!tableIds?.length) return;
  const tbs = await RestaurantTable.find({ _id: { $in: tableIds }, businessId, branchId, active: true }).session(session);
  if (tbs.length !== new Set(tableIds.map(String)).size) throw ApiError.badRequest('A table was not found at this branch', 'TABLE_NOT_FOUND');
  if (!force && tbs.reduce((s, t) => s + t.seats, 0) < partySize) throw ApiError.badRequest(`These tables seat ${tbs.reduce((s, t) => s + t.seats, 0)}, the party is ${partySize}`, 'NOT_ENOUGH_SEATS');
  const clash = await Reservation.findOne({ businessId, branchId, tableIds: { $in: tableIds }, status: { $in: RESERVATION_ACTIVE }, startsAt: { $lt: endsAt }, endsAt: { $gt: startsAt }, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }).session(session);
  if (clash) throw ApiError.conflict(`Table already reserved for ${clash.guestName} at that time (${clash.reservationNumber})`, 'RESERVATION_CONFLICT');
}

async function create(businessId, user, input) {
  C.assertBranchAccess(user, input.branchId);
  return C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    await C.assertBranch(businessId, input.branchId, session);
    const waitlist = !!input.waitlist;
    const dur = input.durationMinutes || ctx.settings.reservation.durationMinutes;
    let startsAt; let endsAt;
    if (!waitlist) {
      if (!input.startsAt) throw ApiError.badRequest('Give the reservation date and time', 'TIME_REQUIRED');
      startsAt = new Date(input.startsAt); endsAt = new Date(startsAt.getTime() + dur * 60000);
      if (startsAt.getTime() < Date.now() - 15 * 60000) throw ApiError.badRequest('That time has already passed', 'TIME_IN_PAST');
      await checkTables(businessId, input.branchId, input.tableIds, input.partySize, startsAt, endsAt, null, session, input.overrideCapacity);
    }
    if (input.customerId && !(await Customer.exists({ _id: input.customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'INVALID_CUSTOMER');
    const seq = await nextSequence(businessId, 'reservation', session);
    const rs = ctx.settings.reservation;
    const depAmount = input.depositAmount ?? (rs.depositRequired ? rs.depositCents : 0);
    const [r] = await Reservation.create([{
      businessId, branchId: input.branchId, reservationNumber: `RS-${pad(seq, 5)}`, guestName: input.guestName, phone: input.phone, customerId: input.customerId, partySize: input.partySize,
      startsAt, endsAt, durationMinutes: dur, tableIds: waitlist ? [] : input.tableIds || [], status: waitlist ? 'WAITLIST' : 'BOOKED', source: input.source || 'STAFF', occasion: input.occasion, notes: input.notes,
      quotedWaitMinutes: input.quotedWaitMinutes, deposit: { required: depAmount > 0, amount: depAmount, kind: input.depositKind || 'DEPOSIT' }, createdBy: user._id,
    }], { session });
    await C.audit({ businessId, branchId: r.branchId, userId: user._id, action: 'restaurant.reservation.create', entityType: 'Reservation', entityId: r._id, newValue: { n: r.reservationNumber, startsAt } }, session);
    return r;
  });
}

const load = async (businessId, id, session) => { const r = await C.withSession(Reservation.findOne({ _id: id, businessId }), session); if (!r) throw ApiError.notFound('Reservation not found', 'RESERVATION_NOT_FOUND'); return r; };
const get = (businessId, id) => load(businessId, id);

async function list(businessId, user, { branchId, status, from, to, search, page = 1, limit = 50 }) {
  const f = { businessId, ...C.branchFilter(C.branchScope(user, branchId)) };
  if (status) f.status = status;
  if (from || to) { f.startsAt = {}; if (from) f.startsAt.$gte = new Date(from); if (to) f.startsAt.$lte = new Date(to); }
  if (search) { const rx = new RegExp(C.escapeRegex(search), 'i'); f.$or = [{ guestName: rx }, { phone: rx }, { reservationNumber: rx }]; }
  const [items, total] = await Promise.all([Reservation.find(f).populate('tableIds', 'name seats').sort({ startsAt: 1, createdAt: 1 }).skip((page - 1) * limit).limit(limit), Reservation.countDocuments(f)]);
  return C.paged(items, total, { page, limit });
}

async function update(businessId, user, id, input) {
  return C.inTx(async (session) => {
    const r = await load(businessId, id, session); C.assertBranchAccess(user, r.branchId);
    if (!['WAITLIST', 'BOOKED', 'CONFIRMED'].includes(r.status)) throw ApiError.conflict(`Reservation is ${r.status}`, 'INVALID_RESERVATION_STATE');
    const startsAt = input.startsAt ? new Date(input.startsAt) : r.startsAt; const dur = input.durationMinutes || r.durationMinutes;
    const tableIds = input.tableIds || r.tableIds; const party = input.partySize || r.partySize;
    if (startsAt) { const endsAt = new Date(startsAt.getTime() + dur * 60000); await checkTables(businessId, r.branchId, tableIds, party, startsAt, endsAt, r._id, session, input.overrideCapacity); r.endsAt = endsAt; }
    Object.assign(r, { ...(input.guestName && { guestName: input.guestName }), ...(input.phone && { phone: input.phone }), ...(input.notes !== undefined && { notes: input.notes }), ...(input.occasion !== undefined && { occasion: input.occasion }), partySize: party, startsAt, durationMinutes: dur, tableIds });
    if (input.startsAt || input.tableIds) { r.reminderSentAt = undefined; r.lateAlertedAt = undefined; r.lockedAt = undefined; }     // moved: alerts and the table lock start over
    if (r.status === 'WAITLIST' && startsAt && tableIds.length) r.status = 'BOOKED';   // promoted from the waiting list
    await r.save({ session }); return r;
  });
}

/** Prepaid money (cents) that has not been used on a bill and is still held. */
const unusedPrepaid = (r) => (r.deposit && r.deposit.paid && !r.deposit.refunded && !r.deposit.forfeited ? Math.max(0, (r.deposit.amount || 0) - (r.deposit.appliedAmount || 0)) : 0);

async function setStatus(businessId, user, id, { status, reason }) {
  const r = await load(businessId, id); C.assertBranchAccess(user, r.branchId);
  const ok = { CONFIRMED: ['BOOKED'], ARRIVED: ['BOOKED', 'CONFIRMED', 'WAITLIST'], CANCELLED: ['WAITLIST', 'BOOKED', 'CONFIRMED', 'ARRIVED'], NO_SHOW: ['BOOKED', 'CONFIRMED'] };
  if (!(ok[status] || []).includes(r.status)) throw ApiError.conflict(`Cannot mark a ${r.status} reservation as ${status}`, 'INVALID_RESERVATION_STATE');
  r.status = status;
  if (status === 'ARRIVED') r.arrivedAt = new Date();
  if (status === 'CANCELLED') { r.cancelledAt = new Date(); r.cancelReason = reason; }
  if (status === 'NO_SHOW') r.noShowAt = new Date();
  await r.save();
  if (['CANCELLED', 'NO_SHOW'].includes(status) && r.tableIds.length) await RestaurantTable.updateMany({ _id: { $in: r.tableIds }, status: 'RESERVED', currentOrderId: null }, { $set: { status: 'AVAILABLE', statusSince: new Date() } });
  if (status === 'NO_SHOW' && unusedPrepaid(r) > 0) {
    const ctx = await C.getContext(businessId);
    if (ctx.settings.reservation.noShowAction === 'FORFEIT') { await Reservation.updateOne({ _id: r._id }, { $set: { 'deposit.forfeited': true } }); r.deposit.forfeited = true; }
  }
  if (unusedPrepaid(r) > 0 && !r.deposit.forfeited && ['CANCELLED', 'NO_SHOW'].includes(status)) C.notifyManagement(businessId, { type: 'SYSTEM_ALERT', title: `Deposit held: ${r.reservationNumber}`, message: `${r.guestName}'s reservation is ${status.toLowerCase().replace('_', ' ')}. Decide whether to refund or forfeit the deposit.`, branchId: r.branchId, entityType: 'Reservation', entityId: r._id });
  await C.audit({ businessId, branchId: r.branchId, userId: user._id, action: `restaurant.reservation.${status.toLowerCase()}`, entityType: 'Reservation', entityId: r._id, newValue: { reason } });
  return r;
}

async function recordDeposit(businessId, user, id, { method, amount, reference }) {
  const saved = await C.inTx(async (session) => {
    const ctx = await C.getContext(businessId, session);
    const r = await load(businessId, id, session); C.assertBranchAccess(user, r.branchId);
    if (r.deposit.paid) throw ApiError.conflict('A deposit was already recorded', 'DEPOSIT_EXISTS');
    if (!['BOOKED', 'CONFIRMED', 'ARRIVED'].includes(r.status)) throw ApiError.conflict(`Reservation is ${r.status}`, 'INVALID_RESERVATION_STATE');
    const shift = await CashShift.findOne({ businessId, branchId: r.branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    if (method === 'CASH' && ctx.settings.paymentsRequireShift && !shift) throw ApiError.badRequest('Open a cash shift before taking cash', 'SHIFT_REQUIRED');
    let provider = 'manual'; let ext; let meta;
    if (method === 'MPESA') { if (!reference) throw ApiError.badRequest('An M-PESA reference is required', 'MPESA_REFERENCE_REQUIRED'); const c = await billSvc.consumeMpesa(businessId, reference, amount, r._id, session); provider = c.channel === 'MANUAL' ? 'payhero-till' : 'payhero'; ext = c.externalTransactionId; meta = { checkoutRequestId: c.checkoutRequestId, channel: c.channel }; }
    const [p] = await Payment.create([{ businessId, branchId: r.branchId, shiftId: shift?._id, customerId: r.customerId, method, provider, amount, reference, externalTransactionId: ext, metadata: { ...(meta || {}), kind: 'RESERVATION_DEPOSIT', reservationId: r._id }, initiatedBy: user._id, status: 'SUCCESS', completedAt: new Date(), ...(method === 'CASH' ? { amountTendered: amount, changeGiven: 0 } : {}) }], { session });
    r.deposit = { ...r.deposit.toObject({ transform: false }), required: true, amount, paid: true, method, reference, paymentId: p._id };
    await r.save({ session });
    await C.audit({ businessId, branchId: r.branchId, userId: user._id, action: 'restaurant.reservation.deposit', entityType: 'Reservation', entityId: r._id, newValue: { amount, method } }, session);
    return r;
  });
  require('../storefront/storefront.service').onDeskPayment('RESERVATION', saved, { method, amount, reference }).catch(() => {});     // online booking: the customer's profile gets the receipt
  return saved;
}

async function settleDeposit(businessId, user, id, { action, method, reason }) {
  C.requireCan(user, 'restaurant.reservations.manage');
  return C.inTx(async (session) => {
    const r = await load(businessId, id, session); C.assertBranchAccess(user, r.branchId);
    const left = unusedPrepaid(r); if (left <= 0) throw ApiError.conflict('There is no unused prepaid amount to settle', 'DEPOSIT_NOT_AVAILABLE');
    if (action === 'FORFEIT') r.deposit.forfeited = true;
    else {
      r.deposit.refunded = true;
      await Payment.create([{ businessId, branchId: r.branchId, customerId: r.customerId, method: method || r.deposit.method, provider: 'manual', amount: left, status: 'REFUNDED', metadata: { kind: 'RESERVATION_DEPOSIT_REFUND', reservationId: r._id }, initiatedBy: user._id, completedAt: new Date() }], { session });
    }
    await r.save({ session });
    await C.audit({ businessId, branchId: r.branchId, userId: user._id, action: `restaurant.reservation.deposit_${action.toLowerCase()}`, entityType: 'Reservation', entityId: r._id, newValue: { reason, amount: left } }, session);
    return r;
  });
}

/** Tables free for a window, big enough in total for the party (single tables first; combos left to the host). */
async function availability(businessId, user, { branchId, startsAt, durationMinutes, partySize }) {
  C.assertBranchAccess(user, branchId);
  const ctx = await C.getContext(businessId);
  const s = new Date(startsAt); const e = new Date(s.getTime() + (durationMinutes || ctx.settings.reservation.durationMinutes) * 60000);
  const [tables, busy] = await Promise.all([RestaurantTable.find({ businessId, branchId, active: true, combinedInto: null }).sort({ seats: 1, name: 1 }), Reservation.find({ businessId, branchId, status: { $in: RESERVATION_ACTIVE }, startsAt: { $lt: e }, endsAt: { $gt: s } }).select('tableIds')]);
  const taken = new Set(busy.flatMap((r) => r.tableIds.map(String)));
  const nowish = s.getTime() <= Date.now() + 30 * 60000;
  const free = tables.filter((t) => !taken.has(String(t._id)) && !(nowish && t.currentOrderId));
  return { window: { startsAt: s, endsAt: e }, tables: free.filter((t) => !partySize || t.seats >= partySize), allFree: free.map((t) => ({ _id: t._id, name: t.name, seats: t.seats })), totalFreeSeats: free.reduce((a, t) => a + t.seats, 0) };
}

/**
 * A reservation that is close enough to its time holds its table: the table shows Reserved and nobody else can seat there. The owner / manager
 * sets how far ahead that happens (`lockMinutes`). Returns the booking holding the table right now, or null.
 */
async function lockingReservation(businessId, tableId, settings, session) {
  const lock = settings && settings.reservation && settings.reservation.lockMinutes != null ? settings.reservation.lockMinutes : 30;
  const now = new Date();
  return C.withSession(Reservation.findOne({ businessId, tableIds: tableId, status: { $in: RESERVATION_ACTIVE }, startsAt: { $lte: new Date(now.getTime() + lock * 60000) }, endsAt: { $gt: now } }).sort({ startsAt: 1 }), session);
}

/** The guest is here: open their order on the reserved table (the prepaid food amount comes off the bill by itself). */
async function seat(businessId, user, id, { guestCount } = {}) {
  C.requireCan(user, 'restaurant.orders.create', 'You need permission to open orders to seat a guest');
  const r = await load(businessId, id); C.assertBranchAccess(user, r.branchId);
  if (!RESERVATION_ACTIVE.includes(r.status)) throw ApiError.conflict(`Reservation is ${r.status}`, 'INVALID_RESERVATION_STATE');
  if (!r.tableIds.length) throw ApiError.badRequest('Give this booking a table first', 'TABLE_REQUIRED');
  const pre = (r.preOrder || []).length ? `PRE-ORDER: ${r.preOrder.map((i) => `${i.quantity}x ${i.name}`).join(', ')}` : undefined;
  const { order } = await require('./order.service').createOrder(businessId, user, {
    branchId: r.branchId, orderType: 'DINE_IN', tableId: r.tableIds[0], guestCount: guestCount || r.partySize, reservationId: r._id, customerId: r.customerId,
    customerName: r.guestName, customerPhone: r.phone, notes: [r.occasion, pre].filter(Boolean).join(' | ') || undefined,
  });
  return { reservation: await load(businessId, id), order };
}

const hm = (d, tz) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d); } catch (e) { return d.toISOString().slice(11, 16); } };
const FORFEIT_NOTE = (r) => (unusedPrepaid(r) > 0 ? ' Their prepaid amount is held: refund or forfeit it.' : '');

/**
 * Job (every minute). For each business, using the owner's settings:
 *   1. guests who never came are marked no-show after `holdMinutes` (prepaid money is kept or held, per `noShowAction`) and the table is freed
 *   2. a table is locked (Reserved) `lockMinutes` before its booking, and released again when nobody holds it
 *   3. staff are told when a guest is late (`lateAlertMinutes`) and before the booking (`remindMinutes`)
 */
async function sweep() {
  const Business = require('../../models/Business');
  const settings = await require('../../models/RestaurantSettings').find({});
  let marked = 0;
  for (const st of settings) {
    try {
      const rs = st.reservation || {}; const now = new Date(); const bid = st.businessId;
      const biz = await Business.findById(bid).select('timezone'); const tz = biz && biz.timezone;
      // 1. no-shows
      if (rs.holdMinutes > 0) {
        const late = await Reservation.find({ businessId: bid, status: { $in: ['BOOKED', 'CONFIRMED'] }, startsAt: { $lt: new Date(now.getTime() - rs.holdMinutes * 60000) } }).limit(100);
        for (const r of late) {
          const forfeit = rs.noShowAction === 'FORFEIT' && unusedPrepaid(r) > 0;
          const got = await Reservation.updateOne({ _id: r._id, status: { $in: ['BOOKED', 'CONFIRMED'] } }, { $set: { status: 'NO_SHOW', noShowAt: now, ...(forfeit ? { 'deposit.forfeited': true } : {}) } });
          if (!got.modifiedCount) continue;
          marked += 1;
          if (r.tableIds.length) await RestaurantTable.updateMany({ _id: { $in: r.tableIds }, status: 'RESERVED', currentOrderId: null }, { $set: { status: 'AVAILABLE', statusSince: now } });
          C.notifyManagement(bid, { type: 'RESERVATION_UPCOMING', title: `No-show: ${r.guestName}`, message: `${r.reservationNumber} (${r.partySize} guests, ${hm(r.startsAt, tz)}) did not arrive within ${rs.holdMinutes} minutes. The table was released.${unusedPrepaid(r) > 0 ? (forfeit ? ' Their prepaid amount was kept by the business.' : FORFEIT_NOTE(r)) : ''}`, branchId: r.branchId, entityType: 'Reservation', entityId: r._id });
        }
      }
      // 2. lock the tables of bookings that are close
      const lock = rs.lockMinutes != null ? rs.lockMinutes : 30;
      const upcoming = await Reservation.find({ businessId: bid, status: { $in: RESERVATION_ACTIVE }, startsAt: { $lte: new Date(now.getTime() + lock * 60000) }, endsAt: { $gt: now } });
      const want = new Set(upcoming.flatMap((r) => r.tableIds.map(String)));
      if (want.size) await RestaurantTable.updateMany({ _id: { $in: [...want] }, status: 'AVAILABLE', currentOrderId: null }, { $set: { status: 'RESERVED', statusSince: now } });
      await RestaurantTable.updateMany({ businessId: bid, status: 'RESERVED', currentOrderId: null, ...(want.size ? { _id: { $nin: [...want] } } : {}) }, { $set: { status: 'AVAILABLE', statusSince: now } });
      for (const r of upcoming.filter((x) => !x.lockedAt)) {            // tell the floor once if the table is still in use when its booking comes up
        const busy = await RestaurantTable.find({ _id: { $in: r.tableIds }, currentOrderId: { $ne: null } }).select('name');
        await Reservation.updateOne({ _id: r._id }, { $set: { lockedAt: now } });
        if (busy.length) C.notifyRoles(bid, r.branchId, C.FLOOR_LEAD_ROLES, { type: 'RESERVATION_UPCOMING', title: `Table ${busy.map((t) => t.name).join(', ')} is reserved for ${hm(r.startsAt, tz)}`, message: `${r.guestName} (${r.partySize} guests, ${r.reservationNumber}) is booked here but the table is still in use. Please clear it in time.`, entityType: 'Reservation', entityId: r._id });
      }
      // 3. late guests and reminders
      if (rs.lateAlertMinutes > 0) {
        const lt = await Reservation.find({ businessId: bid, status: { $in: ['BOOKED', 'CONFIRMED'] }, lateAlertedAt: null, startsAt: { $lt: new Date(now.getTime() - rs.lateAlertMinutes * 60000) } }).limit(100);
        for (const r of lt) { const got = await Reservation.updateOne({ _id: r._id, lateAlertedAt: null }, { $set: { lateAlertedAt: now } }); if (got.modifiedCount) C.notifyRoles(bid, r.branchId, [...C.FLOOR_LEAD_ROLES, 'RECEPTIONIST'], { type: 'RESERVATION_UPCOMING', title: `Late guest: ${r.guestName}`, message: `${r.reservationNumber} was booked for ${hm(r.startsAt, tz)} (${r.partySize} guests, ${r.phone}). Call them${rs.holdMinutes > 0 ? `; the table is released ${rs.holdMinutes} minutes after the booking time` : ''}.`, entityType: 'Reservation', entityId: r._id }); }
      }
      if (rs.remindMinutes > 0) {
        const rem = await Reservation.find({ businessId: bid, status: { $in: RESERVATION_ACTIVE }, reminderSentAt: null, startsAt: { $gt: now, $lte: new Date(now.getTime() + rs.remindMinutes * 60000) } }).limit(100);
        for (const r of rem) {
          const got = await Reservation.updateOne({ _id: r._id, reminderSentAt: null }, { $set: { reminderSentAt: now } });
          if (!got.modifiedCount) continue;
          const tbs = await RestaurantTable.find({ _id: { $in: r.tableIds } }).select('name');
          C.notifyRoles(bid, r.branchId, [...C.FLOOR_LEAD_ROLES, 'RECEPTIONIST'], { type: 'RESERVATION_UPCOMING', title: `Reservation at ${hm(r.startsAt, tz)}: ${r.guestName} (${r.partySize})`, message: `${r.reservationNumber}${tbs.length ? ` · Table ${tbs.map((t) => t.name).join(', ')}` : ''}${r.deposit && r.deposit.paid ? ' · prepaid' : ''}${(r.preOrder || []).length ? ` · pre-order: ${r.preOrder.map((i) => `${i.quantity}x ${i.name}`).join(', ')}` : ''}. Get the table ready.`, entityType: 'Reservation', entityId: r._id });
        }
      }
    } catch (e) { console.error('[reservations] sweep failed for a business:', e.message); }
  }
  return marked;
}

module.exports = { create, get, list, update, setStatus, recordDeposit, settleDeposit, availability, sweep, seat, lockingReservation, unusedPrepaid };
