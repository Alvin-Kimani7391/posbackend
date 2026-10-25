/** Mounted at /api/v1/manager. One read-only overview for the owner / manager. */
const router = require('express').Router();
const c = require('../controllers/manager.controller');
const validate = require('../middleware/validate');
const { authenticate, requireBranchAccess } = require('../middleware/auth');
const requireManagerRole = require('../middleware/requireManagerRole');
const v = require('../validators/manager.validator');
router.use(authenticate, requireManagerRole);
router.get('/overview', validate({ query: v.overviewQuery }), requireBranchAccess, c.overview);
module.exports = router;