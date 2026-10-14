const router = require('express').Router();
const c = require('../controllers/electronics.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/electronics.validator');

router.use(authenticate, requireFeature('serialNumberTracking', 'warrantyManagement'));

router.get('/', requirePermission('warranty.view'), validate({ query: v.claimListQuery }), c.listClaims);
router.post('/', requirePermission('warranty.manage'), requireBranchAccess, validate({ body: v.createClaimSchema }), c.createClaim);
router.get('/:id', requirePermission('warranty.view'), validate({ params: v.idParamSchema }), c.getClaim);
router.post('/:id/decide', requirePermission('warranty.decide'), validate({ params: v.idParamSchema, body: v.decideClaimSchema }), c.decideClaim);
router.post('/:id/supplier-claim', requirePermission('warranty.decide'), validate({ params: v.idParamSchema, body: v.supplierRmaSchema }), c.supplierRma);

module.exports = router;