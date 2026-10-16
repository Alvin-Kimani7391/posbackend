// routes/etims.routes.js
const router = require('express').Router();
const controller = require('../controllers/etims.controller');
const requireCountry = require('../middleware/requireCountry');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);
router.use(requireCountry('KE')); // Kenya-only integration (PayHero M-PESA / KRA eTIMS / Kenyan SMS)
router.get('/', requirePermission('etims.view'), controller.list);
router.post('/:id/retry', requirePermission('etims.submit'), controller.retry);
module.exports = router;