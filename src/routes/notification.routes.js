const router = require('express').Router();
const controller = require('../controllers/notification.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { idParamSchema, listNotificationsQuery, raiseAlertSchema } = require('../validators/notification.validator');

router.use(authenticate);

router.get('/', requirePermission('notifications.view'), validate({ query: listNotificationsQuery }), controller.list);
router.post('/mark-all-read', requirePermission('notifications.view'), controller.markAllRead);
router.post('/:id/read', requirePermission('notifications.view'), validate({ params: idParamSchema }), controller.markRead);
router.delete('/:id', requirePermission('notifications.view'), validate({ params: idParamSchema }), controller.remove);
router.post('/alert', requirePermission('notifications.send'), validate({ body: raiseAlertSchema }), controller.raiseAlert);

module.exports = router;