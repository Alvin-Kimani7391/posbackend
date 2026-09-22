// routes/etims.routes.js
const router = require('express').Router();
const controller = require('../controllers/etims.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
router.use(authenticate);
router.get('/', requirePermission('etims.view'), controller.list);
router.post('/:id/retry', requirePermission('etims.submit'), controller.retry);
module.exports = router;