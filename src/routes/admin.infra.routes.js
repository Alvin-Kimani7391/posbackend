/** Mounted at /api/v1/admin/infra (already behind authenticate + requireSuperAdmin). */
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const infra = require('../services/infra.service');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');

const actionLimiter = rateLimit({ windowMs: 60000, max: 6, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many infrastructure actions. Slow down.' } });
const needOperator = (req, res, next) => (infra.canOperate(req.user) ? next() : next(ApiError.forbidden('Operator permission required', 'INFRA_OPERATOR_ONLY')));

router.get('/overview', catchAsync(async (req, res) => {
  const data = await infra.overview(req.user);
  sendSuccess(res, 200, 'Overview fetched', { ...data, permissions: { canOperate: infra.canOperate(req.user), canPromote: infra.canOperate(req.user) && infra.promoteInfo().available }, promote: infra.promoteInfo() });
}));
router.get('/deployments', catchAsync(async (req, res) => sendSuccess(res, 200, 'Deployments fetched', await infra.deployments())));
router.get('/logs', catchAsync(async (req, res) => {
  const { service, level, q, after, limit } = req.query;
  sendSuccess(res, 200, 'Logs fetched', await infra.logs({ service, level, q: q && String(q).slice(0, 100), after, limit }));
}));

router.post('/rollback', actionLimiter, needOperator, catchAsync(async (req, res) => sendSuccess(res, 200, 'Done', await infra.act(req.user, 'rollback', {}, req.ip))));
router.post('/restart', actionLimiter, needOperator, catchAsync(async (req, res) => sendSuccess(res, 200, 'Done', await infra.act(req.user, 'restart', { service: String(req.body.service || '') }, req.ip))));
router.post('/promote', actionLimiter, needOperator, catchAsync(async (req, res) => sendSuccess(res, 200, 'Done', await infra.promote(req.user, String(req.body.release || ''), req.ip))));
router.post('/backup', actionLimiter, needOperator, catchAsync(async (req, res) => sendSuccess(res, 200, 'Done', await infra.act(req.user, 'backup', {}, req.ip))));
router.post('/maintenance', actionLimiter, needOperator, catchAsync(async (req, res) => sendSuccess(res, 200, 'Done', await infra.act(req.user, 'maintenance', { enabled: req.body.enabled === true }, req.ip))));

module.exports = router;
