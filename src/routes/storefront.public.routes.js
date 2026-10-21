/** PUBLIC storefront API behind the business QR code. Mounted at /api/v1/public/store. No login: the signed token identifies the business. */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const validate = require('../middleware/validate');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const { objectId } = require('../validators/common');
const svc = require('../services/storefront/storefront.service');
const acct = require('../services/hospitality/guest-account.service');
const hv = require('../validators/hospitality.validator');

const lim = (windowMs, max) => rateLimit({ windowMs, max, keyGenerator: (req) => `${req.params.token || ''}:${req.ip}`, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please wait a moment.', code: 'RATE_LIMITED' } });
const read = lim(60000, 90); const poll = lim(60000, 40); const write = lim(10 * 60000, 20); const pay = lim(15 * 60000, 10);
const str = (n = 200) => z.string().trim().max(n);
const tok = { params: z.object({ token: z.string().max(120) }) };
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/); const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);
const num = z.coerce.number();
const h = (fn, msg = 'OK', status = 200) => catchAsync(async (req, res) => sendSuccess(res, status, msg, await fn(req)));
const t = (r) => r.params.token;
const who = (r) => svc.accountFrom(t(r), r);
const auth = lim(15 * 60 * 1000, 25);

const item = z.object({ menuItemId: objectId, quantity: z.coerce.number().min(1).max(50), variantId: objectId.optional(), notes: str(200).optional(),
  modifiers: z.array(z.object({ groupId: objectId, optionId: objectId, quantity: z.coerce.number().int().min(1).max(20).optional() })).max(30).optional(),
  comboPicks: z.array(z.object({ groupName: str(80).optional(), menuItemId: objectId, variantId: objectId.optional(), quantity: z.coerce.number().int().min(1).max(20).optional() })).max(30).optional() });
const delivery = z.object({ payMethod: z.enum(['MPESA', 'CASH']).optional(), branchId: objectId.optional(), name: str(80).min(2), phone: str(20).min(9), address: str(300).min(3), landmark: str(150).optional(), instructions: str(300).optional(), notes: str(300).optional(),
  lat: num.min(-90).max(90), lng: num.min(-180).max(180), items: z.array(item).min(1).max(40), clientRef: str(60).min(8) }).strict();
const quote = z.object({ branchId: objectId.optional(), lat: num.min(-90).max(90), lng: num.max(180).min(-180), subtotal: num.min(0).optional() });
const tablesQ = z.object({ branchId: objectId.optional(), date: ymd.optional(), time: hhmm.optional(), partySize: z.coerce.number().int().min(1).max(50).optional() });
const reserve = z.object({ branchId: objectId.optional(), name: str(80).min(2), phone: str(20).min(9), date: ymd, time: hhmm, partySize: z.coerce.number().int().min(1).max(50), tableId: objectId, occasion: str(80).optional(), notes: str(300).optional(),
  preOrder: z.array(z.object({ menuItemId: objectId, quantity: z.coerce.number().int().min(1).max(50), notes: str(150).optional() })).max(30).optional() }).strict();
const roomsQ = z.object({ branchId: objectId.optional(), checkInDate: ymd, checkOutDate: ymd, adults: z.coerce.number().int().min(1).max(20).optional(), children: z.coerce.number().int().min(0).max(20).optional() });
const book = z.object({ branchId: objectId.optional(), roomTypeId: objectId, checkInDate: ymd, checkOutDate: ymd, name: str(80).min(2), phone: str(20).min(9), email: str(120).optional(), adults: z.coerce.number().int().min(1).max(20).optional(), children: z.coerce.number().int().min(0).max(20).optional(), mealPlan: z.enum(['ROOM_ONLY', 'BED_BREAKFAST', 'HALF_BOARD', 'FULL_BOARD']).optional(), specialRequests: str(300).optional(), clientRef: str(60).min(8) }).strict();
const depBody = z.object({ kind: z.enum(['STAY', 'RESERVATION']), ref: str(40), phone: str(20).min(9), payerPhone: str(20).optional() }).strict();

router.get('/:token', read, validate(tok), h((r) => svc.context(t(r))));
router.get('/:token/menu', read, validate({ ...tok, query: z.object({ branchId: objectId.optional() }) }), h((r) => svc.menu(t(r), r.query)));
router.get('/:token/delivery/quote', read, validate({ ...tok, query: quote }), h((r) => svc.deliveryQuote(t(r), r.query)));
router.post('/:token/delivery', write, validate({ ...tok, body: delivery }), h(async (r) => svc.placeDelivery(t(r), r.body, await who(r)), 'Order placed', 201));
router.get('/:token/delivery/:key', poll, validate({ params: z.object({ token: z.string().max(120), key: z.string().regex(/^[a-f0-9]{16}$/) }) }), h((r) => svc.track(t(r), r.params.key)));
router.get('/:token/tables', read, validate({ ...tok, query: tablesQ }), h((r) => svc.tables(t(r), r.query)));
router.post('/:token/reservations', write, validate({ ...tok, body: reserve }), h(async (r) => svc.reserveTable(t(r), r.body, await who(r)), 'Table booked', 201));
router.get('/:token/reservations/lookup', poll, validate({ ...tok, query: z.object({ reference: str(30), phone: str(20) }) }), h((r) => svc.reservationLookup(t(r), r.query)));
router.get('/:token/rooms', read, validate({ ...tok, query: roomsQ }), h((r) => svc.rooms(t(r), r.query)));
router.post('/:token/bookings', write, validate({ ...tok, body: book }), h(async (r) => svc.bookRoom(t(r), r.body, await who(r)), 'Room booked', 201));
router.get('/:token/bookings/lookup', poll, validate({ ...tok, query: z.object({ code: str(20), phone: str(20) }) }), h((r) => svc.bookingLookup(t(r), r.query)));
router.post('/:token/deposit', pay, validate({ ...tok, body: depBody }), h(async (r) => svc.depositStart(t(r), r.body, await who(r))));
router.get('/:token/deposit/:reference', poll, validate({ params: z.object({ token: z.string().max(120), reference: str(40) }) }), h((r) => svc.depositStatus(t(r), r.params.reference)));

// ---- pay a delivery order with M-PESA STK push, live payment status (also used for table + room payments), e-receipts
router.post('/:token/delivery/:key/pay', pay, validate({ params: z.object({ token: z.string().max(120), key: z.string().regex(/^[a-f0-9]{16}$/) }), body: z.object({ payerPhone: str(20).min(9) }).strict() }), h((r) => svc.orderPayStart(t(r), r.params.key, r.body)));
router.get('/:token/pay/:reference', poll, validate({ params: z.object({ token: z.string().max(120), reference: z.string().regex(/^MPX-[A-F0-9]{12}$/) }) }), h((r) => svc.depositStatus(t(r), r.params.reference)));
router.get('/:token/receipts/:reference', poll, validate({ params: z.object({ token: z.string().max(120), reference: z.string().regex(/^(MPX-[A-F0-9]{12}|BILL-[a-f0-9]{24}-[a-f0-9]{24})$/) }), query: z.object({ phone: str(20).optional() }) }), h((r) => svc.receipt(t(r), r, r.params.reference)));

// ---- ONE account for the storefront and the table/room QR page (same GuestAccount): register, sign in, Google, profile, history
router.post('/:token/account/register', auth, validate({ ...tok, body: hv.acctReg }), h((r) => acct.register(t(r), r.body), 'OK', 201));
router.post('/:token/account/login', auth, validate({ ...tok, body: hv.acctLogin }), h((r) => acct.login(t(r), r.body)));
router.post('/:token/account/google', auth, validate({ ...tok, body: hv.acctGoogle }), h((r) => acct.google(t(r), r.body)));
router.get('/:token/account/me', poll, validate(tok), h((r) => acct.me(t(r), r)));
router.put('/:token/account/profile', write, validate({ ...tok, body: hv.acctProfile }), h((r) => acct.updateProfile(t(r), r, r.body)));
router.get('/:token/account/history', poll, validate(tok), h((r) => svc.history(t(r), r)));
module.exports = router;
