/** Accommodation reports: today's desk, occupancy / ADR / RevPAR, revenue by room type, and the guest register. */
const Stay = require('../../models/Stay');
const Room = require('../../models/Room');
const T = require('../../utils/hospitalityTime');
const ApiError = require('../../utils/ApiError');
const C = require('./common');

const MAX_DAYS = 400;
function range(ctx, { from, to }) {
  const today = T.todayIn(ctx.timeZone);
  const end = to || today; const start = from || T.addDays(end, -29);
  if (!T.ymdOk(start) || !T.ymdOk(end) || end < start) throw ApiError.badRequest('Choose a valid date range', 'INVALID_RANGE');
  if (T.diffDays(start, end) > MAX_DAYS) throw ApiError.badRequest(`Choose at most ${MAX_DAYS} days`, 'RANGE_TOO_LONG');
  return { start, end, today };
}

async function desk(businessId, user, { branchId }) {
  C.requireCan(user, 'accommodation.stays.view', 'Needs permission');
  const ctx = await C.getAccContext(businessId); C.assertAccommodation(ctx);
  const scope = C.branchFilter(C.branchScope(user, branchId)); const today = T.todayIn(ctx.timeZone);
  const sel = 'stayNumber bookingCode status roomNumber roomTypeName guest.name guest.phone adults children checkInDate checkOutDate expectedCheckIn expectedCheckOut totals.balance depositRequired checkoutRequestedAt';
  const [arrivals, departures, inHouse, overdue, rooms, outOfOrder] = await Promise.all([
    Stay.find({ businessId, ...scope, status: 'RESERVED', checkInDate: today }).select(sel).sort({ expectedCheckIn: 1 }),
    Stay.find({ businessId, ...scope, status: 'CHECKED_IN', checkOutDate: today }).select(sel).sort({ expectedCheckOut: 1 }),
    Stay.find({ businessId, ...scope, status: 'CHECKED_IN' }).select(sel).sort({ roomNumber: 1 }),
    Stay.find({ businessId, ...scope, status: 'CHECKED_IN', expectedCheckOut: { $lt: new Date() } }).select(sel),
    Room.countDocuments({ businessId, ...scope, active: true }), Room.countDocuments({ businessId, ...scope, active: true, status: 'OUT_OF_ORDER' }),
  ]);
  const pastNoShow = await Stay.find({ businessId, ...scope, status: 'RESERVED', expectedCheckIn: { $lt: new Date(Date.now() - ctx.acc.noShow.afterHours * 3600000) } }).select(sel);
  const sellable = Math.max(0, rooms - outOfOrder);
  return { date: today, rooms, outOfOrder, occupied: inHouse.length, occupancyPercent: sellable ? Math.round((inHouse.length / sellable) * 1000) / 10 : 0, arrivals, departures, inHouse, overdueCheckouts: overdue, possibleNoShows: pastNoShow };
}

/** Occupancy, average daily rate (room revenue before tax / rooms sold) and RevPAR for each night in the range. */
async function occupancy(businessId, user, { branchId, from, to }) {
  C.requireCan(user, 'accommodation.reports.view', 'Needs permission');
  const ctx = await C.getAccContext(businessId); C.assertAccommodation(ctx);
  const { start, end } = range(ctx, { from, to }); const scope = C.branchFilter(C.branchScope(user, branchId));
  const rooms = await Room.countDocuments({ businessId, ...scope, active: true });
  const stays = await Stay.find({ businessId, ...scope, status: { $in: ['CHECKED_IN', 'CHECKED_OUT'] }, checkInDate: { $lte: end }, checkOutDate: { $gte: start } }).select('folio roomTypeName checkInDate checkOutDate dayUse');
  const days = new Map(); for (let d = start; d <= end; d = T.addDays(d, 1)) days.set(d, { date: d, roomsSold: 0, roomRevenue: 0 });
  const byType = new Map();
  for (const s of stays) for (const l of s.folio) {
    if (l.voided || l.type !== 'ROOM' || !l.nightDate || !days.has(l.nightDate)) continue;
    const day = days.get(l.nightDate); const net = l.total - l.taxAmount; day.roomsSold += 1; day.roomRevenue += net;
    const t = byType.get(s.roomTypeName) || { roomType: s.roomTypeName, nights: 0, revenue: 0 }; t.nights += 1; t.revenue += net; byType.set(s.roomTypeName, t);
  }
  const list = [...days.values()].map((d) => ({ ...d, occupancyPercent: rooms ? Math.round((d.roomsSold / rooms) * 1000) / 10 : 0, adr: d.roomsSold ? Math.round(d.roomRevenue / d.roomsSold) / 100 : 0, revPar: rooms ? Math.round(d.roomRevenue / rooms) / 100 : 0, roomRevenue: d.roomRevenue / 100 }));
  const sold = list.reduce((s, d) => s + d.roomsSold, 0); const rev = [...days.values()].reduce((s, d) => s + d.roomRevenue, 0); const avail = rooms * list.length;
  return { from: start, to: end, rooms, summary: { roomNightsSold: sold, roomNightsAvailable: avail, occupancyPercent: avail ? Math.round((sold / avail) * 1000) / 10 : 0, roomRevenue: rev / 100, adr: sold ? Math.round(rev / sold) / 100 : 0, revPar: avail ? Math.round(rev / avail) / 100 : 0 }, days: list, byRoomType: [...byType.values()].map((t) => ({ ...t, revenue: t.revenue / 100 })) };
}

/** Revenue of closed stays by folio category (rooms, food and beverage, fees, levies...). */
async function revenue(businessId, user, { branchId, from, to }) {
  C.requireCan(user, 'accommodation.reports.view', 'Needs permission');
  const ctx = await C.getAccContext(businessId); const { start, end } = range(ctx, { from, to }); const scope = C.branchFilter(C.branchScope(user, branchId));
  const stays = await Stay.find({ businessId, ...scope, status: 'CHECKED_OUT', actualCheckOut: { $gte: T.zonedToUtc(start, '00:00', ctx.timeZone), $lt: T.zonedToUtc(T.addDays(end, 1), '00:00', ctx.timeZone) } }).select('folio totals stayNumber');
  const cat = new Map(); let total = 0; let tax = 0; let waived = 0; let credit = 0;
  for (const s of stays) { for (const l of s.folio) { if (l.voided) continue; const c = cat.get(l.type) || { type: l.type, amount: 0, tax: 0 }; c.amount += l.total; c.tax += l.taxAmount; cat.set(l.type, c); } total += s.totals.charges; tax += s.totals.tax; waived += s.totals.waived; credit += s.totals.credit; }
  return { from: start, to: end, stays: stays.length, total: total / 100, tax: tax / 100, writtenOff: waived / 100, onCredit: credit / 100, byType: [...cat.values()].map((c) => ({ ...c, amount: c.amount / 100, tax: c.tax / 100 })).sort((a, b) => b.amount - a.amount) };
}

/** The guest register (name, ID, nationality, room, dates): the record authorities may ask a lodging business to keep. */
async function guestRegister(businessId, user, { branchId, from, to }) {
  C.requireCan(user, 'accommodation.reports.view', 'Needs permission');
  const ctx = await C.getAccContext(businessId); const { start, end } = range(ctx, { from, to }); const scope = C.branchFilter(C.branchScope(user, branchId));
  const rows = await Stay.find({ businessId, ...scope, status: { $in: ['CHECKED_IN', 'CHECKED_OUT'] }, checkInDate: { $lte: end }, checkOutDate: { $gte: start } }).select('stayNumber roomNumber guest otherGuests adults children actualCheckIn actualCheckOut checkInDate checkOutDate status').sort({ actualCheckIn: 1 });
  return { from: start, to: end, count: rows.length, guests: rows.map((s) => ({ stayNumber: s.stayNumber, room: s.roomNumber, name: s.guest.name, idType: s.guest.idType, idNumber: s.guest.idNumber, nationality: s.guest.nationality, phone: s.guest.phone, address: s.guest.address, vehiclePlate: s.guest.vehiclePlate, adults: s.adults, children: s.children, otherGuests: s.otherGuests, checkIn: s.actualCheckIn, checkOut: s.actualCheckOut, status: s.status })) };
}

module.exports = { desk, occupancy, revenue, guestRegister };
