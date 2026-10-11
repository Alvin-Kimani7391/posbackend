const router = require('express').Router();
const controller = require('../controllers/offline-review.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { reviewListQuery, idParamSchema, optionalNoteSchema, requiredNoteSchema, rejectClaimSchema, gapsQuery } = require('../validators/sync.validator');

router.use(authenticate);
router.use(requirePermission('offline.review'));

// Sales the server flagged HIGH
router.get('/review/sales', validate({ query: reviewListQuery }), controller.listSales);
router.post('/review/sales/:id/resolve', validate({ params: idParamSchema, body: optionalNoteSchema }), controller.resolveSale);

// Offline M-PESA till payments waiting for a manager / owner
router.get('/review/mpesa', validate({ query: reviewListQuery }), controller.listClaims);
router.post('/review/mpesa/:id/approve', validate({ params: idParamSchema, body: optionalNoteSchema }), controller.approveClaim);
router.post('/review/mpesa/:id/reject', validate({ params: idParamSchema, body: rejectClaimSchema }), controller.rejectClaim);

// Quarantine: sales that could not be recorded (nothing is ever lost)
router.get('/review/quarantine', validate({ query: reviewListQuery }), controller.listQuarantine);
router.get('/review/quarantine/:id', validate({ params: idParamSchema }), controller.getQuarantine);
router.post('/review/quarantine/:id/release', validate({ params: idParamSchema, body: requiredNoteSchema }), controller.release);
router.post('/review/quarantine/:id/discard', validate({ params: idParamSchema, body: requiredNoteSchema }), controller.discard);

// Offline shifts that were flagged, and the badge counts
router.get('/review/shifts', validate({ query: reviewListQuery }), controller.listShifts);
router.post('/review/shifts/:id/resolve', validate({ params: idParamSchema, body: optionalNoteSchema }), controller.resolveShift);
router.get('/review/summary', controller.summary);

// Missing local receipt numbers for a device
router.get('/review/gaps', validate({ query: gapsQuery }), controller.gaps);

module.exports = router;