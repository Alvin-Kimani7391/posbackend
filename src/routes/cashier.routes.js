/**
 * Cashier dashboard. Mounted at /api/v1/cashier.
 * Checks on every route, in this order:
 *   authenticate           the business comes from the login, never from the request
 *   requireCashierRole     OWNER, MANAGER or CASHIER only (constants/cashier.js)
 *   module check           the restaurant or accommodation service must be on for THIS business
 *   requirePermission      the specific cashier.* / restaurant.* permission
 * Taking money is NOT done here: payments keep going through /restaurant/bills/:id/pay, /restaurant/self-service/... and
 * /accommodation/stays/:id/payments, which hold the rules (shift required, M-PESA verification, idempotency, receipts).
 */
const router = require('express').Router();
const c = require('../controllers/cashier.controller');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const requireCashierRole = require('../middleware/requireCashierRole');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/cashier.validator');
const ApiError = require('../utils/ApiError');

/** The dashboard works for restaurants AND for accommodation-only businesses: either module being on is enough. */
const anyHospitalityModule = (req, res, next) => {
  const f = (req.businessDoc && req.businessDoc.featureSettings) || {};
  if (f.restaurantOrdering === true || f.accommodation === true) return next();
  return next(ApiError.forbidden('Turn on the restaurant or accommodation service to use the cashier dashboard.', 'FEATURE_DISABLED'));
};

router.use(authenticate, requireCashierRole, anyHospitalityModule);

router.get('/overview', P('cashier.view'), validate({ query: v.branchQ }), requireBranchAccess, c.overview);
router.get('/queue', P('cashier.view'), validate({ query: v.queueQuery }), requireBranchAccess, c.queue);
router.get('/orders/:id', P('cashier.view'), validate({ params: v.idParam }), c.orderDetail);
router.get('/payments', P('cashier.view'), validate({ query: v.paymentsQuery }), requireBranchAccess, c.payments);

router.get('/drawer', P('cashier.drawer'), validate({ query: v.branchQ }), requireBranchAccess, c.drawer);
router.post('/drawer/events', P('cashier.drawer'), validate({ body: v.drawerEventBody }), idempotent('POST /cashier/drawer/events'), c.drawerEvent);

router.post('/bills/:id/reprint', P('cashier.view'), validate({ params: v.idParam }), c.reprint);

module.exports = router;
