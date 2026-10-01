/**
 * Tenant-facing announcements, mounted at /api/v1/announcements.
 * Any authenticated user may read what is targeted at them - no permission
 * key is needed (every role, including ones with no notifications.view, should
 * see platform notices).
 */
const router = require('express').Router();
const controller = require('../controllers/announcement.controller');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { activeQuery } = require('../validators/announcement.validator');

router.use(authenticate);

router.get('/active', validate({ query: activeQuery }), controller.active);

module.exports = router;