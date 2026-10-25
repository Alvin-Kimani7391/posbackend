/**
 * Accommodation (rooms, stays, folios, housekeeping). Mounted at /api/v1/accommodation.
 * Every route: authenticate (tenant) + requireFeature('accommodation') (this business offers rooms) + requirePermission,
 * with branch scoping inside the services.
 */
const router = require('express').Router();
const c = require('../controllers/hospitality.controller');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/hospitality.validator');
const { uploadRoomTypeImages, uploadRoomImages } = require('../middleware/hospitalityUpload');

router.use(authenticate, requireFeature('accommodation'));
const id = { params: v.idParam };

router.get('/settings', P('accommodation.settings.view'), c.getSettings);
router.put('/settings', P('accommodation.settings.manage'), validate({ body: v.settingsSchema }), c.updateSettings);

router.get('/room-types', P('accommodation.rooms.view'), c.listRoomTypes);
router.post('/room-types', P('accommodation.rooms.manage'), validate({ body: v.roomTypeBody }), c.createRoomType);
router.post('/images', P('accommodation.rooms.manage'), uploadRoomImages, c.uploadRoomPhotos);
router.post('/room-types/:id/images', P('accommodation.rooms.manage'), validate(id), uploadRoomTypeImages, c.uploadRoomTypeImages);
router.put('/room-types/:id', P('accommodation.rooms.manage'), validate({ ...id, body: v.roomTypeUpdate }), c.updateRoomType);

router.get('/board', P('accommodation.rooms.view'), validate({ query: v.boardQuery }), requireBranchAccess, c.board);
router.post('/rooms', P('accommodation.rooms.manage'), validate({ body: v.roomBody }), requireBranchAccess, c.createRoom);
router.post('/rooms/bulk', P('accommodation.rooms.manage'), validate({ body: v.roomBulk }), requireBranchAccess, c.bulkRooms);
router.put('/rooms/:id', P('accommodation.rooms.manage'), validate({ ...id, body: v.roomUpdate }), c.updateRoom);
router.post('/rooms/:id/status', P('accommodation.rooms.status'), validate({ ...id, body: v.roomStatus }), c.roomStatus);
router.post('/rooms/:id/housekeeping', P('accommodation.housekeeping.update'), validate({ ...id, body: v.housekeepingBody }), c.roomHousekeeping);

router.get('/availability', P('accommodation.stays.view'), validate({ query: v.availabilityQuery }), requireBranchAccess, c.availability);
router.get('/stays', P('accommodation.stays.view'), validate({ query: v.stayListQuery }), c.listStays);
router.post('/stays', P('accommodation.stays.create'), validate({ body: v.reserveBody }), requireBranchAccess, idempotent('POST /accommodation/stays'), c.reserve);
router.get('/stays/:id', P('accommodation.stays.view'), validate(id), c.getStay);
router.put('/stays/:id', P('accommodation.stays.manage'), validate({ ...id, body: v.stayUpdate }), c.updateStay);
router.post('/stays/:id/check-in', P('accommodation.stays.checkin'), validate({ ...id, body: v.checkInBody }), c.checkIn);
router.get('/stays/:id/checkout-quote', P('accommodation.stays.checkout'), validate({ ...id, query: v.quoteQuery }), c.checkoutQuote);
router.post('/stays/:id/check-out', P('accommodation.stays.checkout'), validate({ ...id, body: v.checkOutBody }), idempotent('POST /accommodation/stays/check-out'), c.checkOut);
router.post('/stays/:id/move', P('accommodation.stays.manage'), validate({ ...id, body: v.moveBody }), c.moveRoom);
router.post('/stays/:id/dates', P('accommodation.stays.manage'), validate({ ...id, body: v.datesBody }), c.changeDates);
router.post('/stays/:id/cancel', P('accommodation.stays.manage'), validate({ ...id, body: v.cancelBody }), c.cancelStay);
router.post('/stays/:id/no-show', P('accommodation.stays.manage'), validate({ ...id, body: v.noShowBody }), c.noShow);
router.get('/stays/:id/guest-card', P('accommodation.stays.checkin'), validate(id), c.guestCard);
router.post('/stays/:id/reset-pin', P('accommodation.stays.manage'), validate(id), c.resetPin);

router.post('/stays/:id/charges', P('accommodation.folio.charge'), validate({ ...id, body: v.chargeBody }), c.addCharge);
router.post('/stays/:id/charges/:lineId/void', P('accommodation.folio.adjust'), validate({ params: v.lineParam, body: v.voidLineBody }), c.voidLine);
router.post('/stays/:id/mpesa/stk', P('accommodation.folio.pay'), validate({ ...id, body: v.stkBody }), c.mpesaStk);
router.post('/stays/:id/mpesa/manual', P('accommodation.folio.pay'), validate({ ...id, body: v.manualBody }), c.mpesaManual);
router.get('/mpesa/:reference/status', P('accommodation.folio.pay'), validate({ params: v.refParam }), c.mpesaStatus);
router.post('/mpesa/:reference/claim', P('accommodation.folio.pay'), validate({ params: v.refParam, body: v.claimBody }), c.mpesaClaim);
router.post('/mpesa/:reference/cancel', P('accommodation.folio.pay'), validate({ params: v.refParam }), c.mpesaCancel);
router.get('/pay-context', P('accommodation.stays.view'), validate({ query: v.contextQuery }), c.payContext);
router.post('/shift/open', P('accommodation.folio.pay'), validate({ body: v.openShiftBody }), c.openCashShift);
router.get('/payments/unverified', P('accommodation.folio.verify'), validate({ query: v.unverifiedQuery }), c.unverified);
router.post('/stays/:id/payments/:entryId/verify', P('accommodation.folio.verify'), validate({ params: v.entryParam, body: v.verifyBody }), c.verifyPayment);
router.post('/stays/:id/payments', P('accommodation.folio.pay'), validate({ ...id, body: v.folioPayBody }), idempotent('POST /accommodation/stays/payments'), c.addPayment);
router.post('/stays/:id/refund', P('accommodation.folio.refund'), validate({ ...id, body: v.folioRefundBody }), c.refund);

router.get('/housekeeping/tasks', P('accommodation.housekeeping.view'), validate({ query: v.taskQuery }), c.listTasks);
router.post('/housekeeping/tasks', P('accommodation.housekeeping.manage'), validate({ body: v.taskCreate }), c.createTask);
router.put('/housekeeping/tasks/:id', P('accommodation.housekeeping.update'), validate({ ...id, body: v.taskUpdate }), c.updateTask);

router.get('/desk', P('accommodation.stays.view'), validate({ query: v.branchQ }), c.desk);
router.get('/reports/occupancy', P('accommodation.reports.view'), validate({ query: v.rangeQuery }), c.occupancy);
router.get('/reports/revenue', P('accommodation.reports.view'), validate({ query: v.rangeQuery }), c.revenue);
router.get('/reports/guest-register', P('accommodation.reports.view'), validate({ query: v.rangeQuery }), c.guestRegister);

module.exports = router;
