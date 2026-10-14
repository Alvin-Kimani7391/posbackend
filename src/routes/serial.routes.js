const router = require('express').Router();
const c = require('../controllers/electronics.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/electronics.validator');

router.use(authenticate, requireFeature('serialNumberTracking'));

router.get('/', requirePermission('serials.view'), validate({ query: v.serialListQuery }), c.listSerials);
router.get('/lookup', requirePermission('serials.view'), validate({ query: v.serialLookupQuery }), c.lookupSerial);
router.get('/warranties/expiring', requirePermission('serials.view'), validate({ query: v.expiringWarrantyQuery }), c.warrantiesExpiring);
router.post('/:id/inspect', requirePermission('serials.manage'), validate({ params: v.idParamSchema, body: v.inspectSchema }), c.inspectSerial);

module.exports = router;