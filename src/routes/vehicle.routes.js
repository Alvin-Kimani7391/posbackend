const router = require('express').Router();
const c = require('../controllers/garage.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission } = require('../middleware/auth');
const v = require('../validators/garage.validator');

router.use(authenticate, requireFeature('vehicleManagement'));

router.get('/', requirePermission('vehicles.view'), validate({ query: v.vehicleListQuery }), c.listVehicles);
router.get('/lookup', requirePermission('vehicles.view'), validate({ query: v.vehicleLookupQuery }), c.lookupVehicle);
router.get('/due-for-service', requirePermission('vehicles.view'), validate({ query: v.dueQuery }), c.dueForService);
router.post('/', requirePermission('vehicles.manage'), validate({ body: v.createVehicleSchema }), c.createVehicle);
router.get('/:id', requirePermission('vehicles.view'), validate({ params: v.idParamSchema }), c.getVehicle);
router.put('/:id', requirePermission('vehicles.manage'), validate({ params: v.idParamSchema, body: v.updateVehicleSchema }), c.updateVehicle);
router.get('/:id/history', requirePermission('vehicles.view'), validate({ params: v.idParamSchema, query: v.historyQuery }), c.vehicleHistory);

module.exports = router;