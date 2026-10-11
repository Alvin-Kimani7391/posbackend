const router = require('express').Router();
const { z } = require('zod');
const controller = require('../controllers/device.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission, requireBranchAccess } = require('../middleware/auth');
const {
  enrollDeviceSchema, updateDeviceSchema, revokeDeviceSchema, grantSchema, heartbeatSchema,
  listDevicesQuery, idParamSchema, offlinePolicySchema,
} = require('../validators/device.validator');

router.use(authenticate);

// Business offline policy (read: managers; write: owner only, enforced in the service)
router.get('/policy', requirePermission('devices.manage'), controller.getPolicy);
router.put('/policy', requirePermission('devices.manage'), validate({ body: offlinePolicySchema }), controller.updatePolicy);

// Cashier on an enrolled device (online): get an offline grant, send a heartbeat
router.post('/grant', requirePermission('sales.create'), validate({ body: grantSchema }), controller.grant);
router.post('/heartbeat', requirePermission('sales.create'), validate({ body: heartbeatSchema }), controller.heartbeat);


router.put('/offline-pin', requirePermission('sales.create'), validate({ body: z.object({ password: z.string().min(1).max(200), pin: z.string().regex(/^\d{6,8}$/) }) }), controller.setPin);
router.post('/roster', requirePermission('devices.manage'), validate({ body: grantSchema }), controller.roster);


// Device management (manager/owner)
router.get('/', requirePermission('devices.manage'), validate({ query: listDevicesQuery }), controller.list);
router.post('/enroll', requirePermission('devices.manage'), requireBranchAccess, validate({ body: enrollDeviceSchema }), controller.enroll);
router.patch('/:id', requirePermission('devices.manage'), validate({ params: idParamSchema, body: updateDeviceSchema }), controller.update);
router.post('/:id/revoke', requirePermission('devices.manage'), validate({ params: idParamSchema, body: revokeDeviceSchema }), controller.revoke);

module.exports = router;