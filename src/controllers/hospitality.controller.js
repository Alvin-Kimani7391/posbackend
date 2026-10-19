const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const rooms = require('../services/hospitality/room.service');
const stays = require('../services/hospitality/stay.service');
const folio = require('../services/hospitality/folio.service');
const reports = require('../services/hospitality/accommodation-report.service');
const guest = require('../services/hospitality/guest.service');
const calls = require('../services/hospitality/servicecall.service');
const qr = require('../services/hospitality/qr.service');
const orders = require('../services/restaurant/order.service');

const ApiError = require('../utils/ApiError');
const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (req) => req.businessId; const u = (req) => req.user;
const clean = (stay) => { const o = stay.toJSON ? stay.toJSON() : stay; delete o.guestPinHash; return o; };

module.exports = {
  // ---- accommodation settings, room types, rooms
  getSettings: h(200, 'Accommodation settings fetched', async (r) => ({ settings: await rooms.getSettings(b(r)) })),
  updateSettings: h(200, 'Accommodation settings updated', async (r) => ({ settings: await rooms.updateSettings(b(r), u(r)._id, r.body) })),
  listRoomTypes: h(200, 'Room types fetched', async (r) => ({ roomTypes: await rooms.listRoomTypes(b(r), { includeInactive: r.query.all === 'true' }) })),
  createRoomType: h(201, 'Room type created', async (r) => ({ roomType: await rooms.createRoomType(b(r), u(r)._id, r.body) })),
  uploadRoomTypeImages: h(200, 'Images uploaded', async (r) => {
    const urls = (r.files || []).map((f) => f.path).filter(Boolean);
    if (!urls.length) throw ApiError.badRequest('Attach images in the "images" field', 'NO_FILE');
    const cur = await rooms.listRoomTypes(b(r), { includeInactive: true });
    const rt = cur.find((x) => String(x._id) === r.params.id);
    if (!rt) throw ApiError.notFound('Room type not found');
    return { roomType: await rooms.updateRoomType(b(r), u(r)._id, r.params.id, { images: [...(rt.images || []), ...urls].slice(0, 12) }) };
  }),
  updateRoomType: h(200, 'Room type updated', async (r) => ({ roomType: await rooms.updateRoomType(b(r), u(r)._id, r.params.id, r.body) })),
  createRoom: h(201, 'Room created', async (r) => ({ room: await rooms.createRoom(b(r), u(r)._id, r.body) })),
  bulkRooms: h(201, 'Rooms created', async (r) => rooms.bulkCreateRooms(b(r), u(r)._id, r.body)),
  updateRoom: h(200, 'Room updated', async (r) => ({ room: await rooms.updateRoom(b(r), u(r)._id, r.params.id, r.body) })),
  roomStatus: h(200, 'Room status updated', async (r) => ({ room: await rooms.setStatus(b(r), u(r), r.params.id, r.body) })),
  roomHousekeeping: h(200, 'Housekeeping status updated', async (r) => ({ room: await rooms.setHousekeeping(b(r), u(r), r.params.id, r.body) })),
  board: h(200, 'Room rack fetched', async (r) => rooms.board(b(r), u(r), r.query)),
  // ---- stays
  availability: h(200, 'Availability fetched', async (r) => stays.availability(b(r), u(r), r.query)),
  listStays: h(200, 'Stays fetched', async (r) => stays.listStays(b(r), u(r), r.query)),
  getStay: h(200, 'Stay fetched', async (r) => { const x = await stays.getStay(b(r), u(r), r.params.id); return { ...x, stay: clean(x.stay) }; }),
  reserve: h(201, 'Room booked', async (r) => {
    const out = await stays.reserve(b(r), u(r), r.body);
    if (r.body.checkInNow && !out.replayed) { const ci = await stays.checkIn(b(r), u(r), out.stay._id, {}); return { stay: clean(ci.stay), pin: ci.pin, earlyFee: ci.earlyFee, replayed: false }; }
    return { stay: clean(out.stay), replayed: out.replayed };
  }),
  checkIn: h(200, 'Guest checked in', async (r) => { const o = await stays.checkIn(b(r), u(r), r.params.id, r.body); return { stay: clean(o.stay), pin: o.pin, earlyFee: o.earlyFee }; }),
  checkoutQuote: h(200, 'Check-out quote', async (r) => { const q = await stays.checkoutQuote(b(r), u(r), r.params.id, r.query); return { adds: q.adds, voids: q.voids, notes: q.notes }; }),
  checkOut: h(200, 'Guest checked out', async (r) => { const o = await stays.checkOut(b(r), u(r), r.params.id, r.body); return { stay: clean(o.stay), sale: o.sale, change: o.change, notes: o.notes }; }),
  moveRoom: h(200, 'Guest moved', async (r) => ({ stay: clean(await stays.moveRoom(b(r), u(r), r.params.id, r.body)) })),
  changeDates: h(200, 'Dates changed', async (r) => ({ stay: clean(await stays.changeDates(b(r), u(r), r.params.id, r.body)) })),
  updateStay: h(200, 'Stay updated', async (r) => ({ stay: clean(await stays.updateStay(b(r), u(r), r.params.id, r.body)) })),
  cancelStay: h(200, 'Booking cancelled', async (r) => { const o = await stays.cancel(b(r), u(r), r.params.id, r.body); return { ...o, stay: clean(o.stay) }; }),
  noShow: h(200, 'Booking marked as no-show', async (r) => { const o = await stays.markNoShow(b(r), u(r), r.params.id, r.body); return { ...o, stay: clean(o.stay) }; }),
  resetPin: h(200, 'New guest code issued', async (r) => stays.resetPin(b(r), u(r), r.params.id)),
  // ---- folio
  addCharge: h(201, 'Charge posted', async (r) => ({ stay: clean(await folio.addCharge(b(r), u(r), r.params.id, r.body)) })),
  voidLine: h(200, 'Charge removed', async (r) => ({ stay: clean(await folio.voidLine(b(r), u(r), r.params.id, r.params.lineId, r.body)) })),
  addPayment: h(201, 'Payment recorded', async (r) => { const o = await folio.addPayment(b(r), u(r), r.params.id, r.body); return { stay: clean(o.stay), payment: o.payment }; }),
  mpesaStk: h(200, 'STK push sent', async (r) => folio.mpesaStk(b(r), u(r), r.params.id, r.body)),
  mpesaManual: h(200, 'Till payment request created', async (r) => folio.mpesaManual(b(r), u(r), r.params.id, r.body)),
  mpesaStatus: h(200, 'M-PESA status fetched', async (r) => folio.mpesaStatus(b(r), r.params.reference)),
  mpesaClaim: h(200, 'M-PESA payment claimed', async (r) => folio.mpesaClaim(b(r), u(r), r.params.reference, r.body.receiptCode)),
  mpesaCancel: h(200, 'M-PESA request cancelled', async (r) => folio.mpesaCancel(b(r), r.params.reference)),
  payContext: h(200, 'Payment options fetched', async (r) => folio.payContext(b(r), u(r), r.query.branchId)),
  openCashShift: h(201, 'Shift opened', async (r) => ({ shift: await folio.openCashShift(b(r), u(r), r.body) })),
  unverified: h(200, 'Payments awaiting verification', async (r) => ({ payments: await require('../services/paymentVerify.service').listUnverified(b(r), u(r), r.query, { restaurant: false }) })),
  verifyPayment: h(200, 'Payment checked', async (r) => ({ payment: await require('../services/paymentVerify.service').verifyStay(b(r), u(r), r.params.id, r.params.entryId, r.body) })),
  refund: h(200, 'Refund recorded', async (r) => ({ stay: clean(await folio.refund(b(r), u(r), r.params.id, r.body)) })),
  // ---- housekeeping
  listTasks: h(200, 'Housekeeping tasks fetched', async (r) => ({ tasks: await rooms.listTasks(b(r), u(r), r.query) })),
  createTask: h(201, 'Task created', async (r) => ({ task: await rooms.createTask(b(r), u(r), r.body) })),
  updateTask: h(200, 'Task updated', async (r) => ({ task: await rooms.updateTask(b(r), u(r), r.params.id, r.body) })),
  // ---- reports
  desk: h(200, 'Front desk fetched', async (r) => reports.desk(b(r), u(r), r.query)),
  occupancy: h(200, 'Occupancy report', async (r) => reports.occupancy(b(r), u(r), r.query)),
  revenue: h(200, 'Accommodation revenue report', async (r) => reports.revenue(b(r), u(r), r.query)),
  guestRegister: h(200, 'Guest register', async (r) => reports.guestRegister(b(r), u(r), r.query)),

  // ---- staff side of guest QR ordering
  listRequests: h(200, 'Guest orders fetched', async (r) => ({ requests: await guest.listRequests(b(r), u(r), r.query) })),
  acceptRequest: h(200, 'Guest order accepted', async (r) => ({ request: await guest.accept(b(r), u(r), r.params.id, r.body) })),
  rejectRequest: h(200, 'Guest order declined', async (r) => ({ request: await guest.reject(b(r), u(r), r.params.id, r.body) })),
  listCalls: h(200, 'Guest requests fetched', async (r) => ({ calls: await calls.list(b(r), u(r), r.query) })),
  createCall: h(201, 'Request logged', async (r) => calls.create(b(r), u(r), r.body)),
  ackCall: h(200, 'Request acknowledged', async (r) => ({ call: await calls.acknowledge(b(r), u(r), r.params.id) })),
  resolveCall: h(200, 'Request resolved', async (r) => ({ call: await calls.resolve(b(r), u(r), r.params.id) })),
  listQr: h(200, 'QR codes fetched', async (r) => ({ codes: await qr.listQr(b(r), u(r), r.query) })),
  rotateQr: h(200, 'QR code replaced', async (r) => qr.rotate(b(r), u(r), r.params)),
  enableQr: h(200, 'QR code updated', async (r) => qr.setEnabled(b(r), u(r), { ...r.params, enabled: r.body.enabled })),
  claimOrder: h(200, 'Order claimed', async (r) => ({ order: await orders.claimOrder(b(r), u(r), r.params.id) })),

  // ---- public (no login)
  pContext: h(200, 'OK', async (r) => guest.context(r.params.token)),
  pMenu: h(200, 'OK', async (r) => guest.menu(r.params.token)),
  pOrder: h(201, 'OK', async (r) => guest.submit(r.params.token, r.body, { ip: r.ip })),
  pStatus: h(200, 'OK', async (r) => guest.status(r.params.token, { pin: r.query.pin || r.headers['x-guest-pin'] })),
  pCall: h(201, 'OK', async (r) => guest.call(r.params.token, r.body)),
  pFolio: h(200, 'OK', async (r) => guest.folioView(r.params.token, { pin: r.query.pin || r.headers['x-guest-pin'] })),
  pRequestCheckout: h(200, 'OK', async (r) => guest.requestCheckout(r.params.token, r.body)),
  pCheckOut: h(200, 'OK', async (r) => guest.selfCheckOut(r.params.token, r.body)),
  pCheckIn: h(200, 'OK', async (r) => guest.selfCheckIn(r.params.token, r.body, { ip: r.ip })),
};
