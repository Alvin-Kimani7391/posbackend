const router = require('express').Router();
const controller = require('../controllers/auditlog.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditLogQuery } = require('../validators/report.validator');

router.use(authenticate);

router.get('/', requirePermission('audit.view'), validate({ query: auditLogQuery }), controller.list);

module.exports = router;