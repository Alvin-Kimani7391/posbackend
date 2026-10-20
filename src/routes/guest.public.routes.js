/**
 * PUBLIC guest API behind the table / room QR codes. Mounted at /api/v1/public/qr. NO LOGIN: the signed token in the URL
 * identifies one table or room (see qr.service), a room also needs the PIN, and every action is limited by the owner's settings.
 * Extra rate limits here sit on top of the global one; they are per token + IP so one noisy table cannot lock out another.
 */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const c = require('../controllers/hospitality.controller');
const validate = require('../middleware/validate');
const v = require('../validators/hospitality.validator');

const key = (req) => `${req.params.token || ''}:${req.ip}`;
const lim = (windowMs, max) => rateLimit({ windowMs, max, keyGenerator: key, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many requests. Please wait a moment or call a waiter.', code: 'RATE_LIMITED' } });
const read = lim(60 * 1000, 90);
const write = lim(60 * 1000, 12);
const pinTry = lim(15 * 60 * 1000, 30);
const poll = lim(60 * 1000, 40);        // live order tracking refreshes every few seconds; wrong PINs still lock the stay (see stay.service.verifyPin)
const tok = { params: v.tokenParam };

router.get('/:token', read, validate(tok), c.pContext);
router.get('/:token/menu', read, validate(tok), c.pMenu);
router.get('/:token/status', poll, validate({ ...tok, query: v.pinQuery }), c.pStatus);
router.post('/:token/orders', write, pinTry, validate({ ...tok, body: v.guestOrder }), c.pOrder);
router.post('/:token/calls', write, pinTry, validate({ ...tok, body: v.guestCall }), c.pCall);
router.get('/:token/folio', poll, validate({ ...tok, query: v.pinQuery }), c.pFolio);
router.post('/:token/request-checkout', write, pinTry, validate({ ...tok, body: v.guestPinOnly }), c.pRequestCheckout);
router.post('/:token/check-out', write, pinTry, validate({ ...tok, body: v.guestPinOnly }), c.pCheckOut);
const auth = lim(15 * 60 * 1000, 25);
router.post('/:token/account/register', auth, validate({ ...tok, body: v.acctReg }), c.aRegister);
router.post('/:token/account/login', auth, validate({ ...tok, body: v.acctLogin }), c.aLogin);
router.post('/:token/account/google', auth, validate({ ...tok, body: v.acctGoogle }), c.aGoogle);
router.put('/:token/account/profile', write, validate({ ...tok, body: v.acctProfile }), c.aProfile);
router.get('/:token/account/me', poll, validate(tok), c.aMe);
router.post('/:token/account/claim', write, validate({ ...tok, body: v.acctClaim }), c.aClaim);
router.get('/:token/account/history', poll, validate(tok), c.aHistory);
router.get('/:token/account/receipts/:reference', poll, validate({ params: v.acctRef }), c.aReceipt);
router.get('/:token/bill', poll, validate({ ...tok, query: v.pinQuery }), c.pBill);
router.post('/:token/pay', write, validate({ ...tok, body: v.guestPay }), c.pPay);
router.get('/:token/pay/:reference', poll, validate({ params: v.payRefParam, query: v.pinQuery }), c.pPayStatus);
router.get('/:token/receipt/:reference', poll, validate({ params: v.payRefParam, query: v.pinQuery }), c.pReceipt);
router.post('/:token/charge-room', write, validate({ ...tok, body: v.guestCharge }), c.pChargeRoom);
router.get('/:token/stay', poll, validate({ ...tok, query: v.pinQuery }), c.pStay);
router.get('/:token/deals', read, validate(tok), c.pDeals);
router.post('/:token/enquiry', write, validate({ ...tok, body: v.guestEnquiry }), c.pEnquiry);
router.post('/:token/check-in', write, pinTry, validate({ ...tok, body: v.guestSelfCheckIn }), c.pCheckIn);

module.exports = router;
