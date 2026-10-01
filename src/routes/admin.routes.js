/**
 * Platform-admin API, mounted at /api/v1/admin.
 * EVERY route is behind authenticate + requireSuperAdmin - no tenant user,
 * not even an OWNER, can reach these.
 */
const router = require('express').Router();
const controller = require('../controllers/admin.controller');
const ticketAdmin = require('../controllers/ticket.admin.controller');
const announcementAdmin = require('../controllers/announcement.admin.controller');
const validate = require('../middleware/validate');
const { authenticate, requireSuperAdmin } = require('../middleware/auth');
const { uploadTicketImages } = require('../middleware/ticketUpload');
const v = require('../validators/admin.validator');
const tv = require('../validators/ticket.validator');
const av = require('../validators/announcement.validator');

router.use(authenticate, requireSuperAdmin);

router.get('/overview', validate({ query: v.overviewQuery }), controller.overview);

router.get('/businesses', validate({ query: v.businessesQuery }), controller.listBusinesses);
router.get('/businesses/:id', validate({ params: v.idParamSchema }), controller.getBusiness);
router.patch('/businesses/:id/status', validate({ params: v.idParamSchema, body: v.businessStatusSchema }), controller.setBusinessStatus);

router.get('/sales', validate({ query: v.salesQuery }), controller.listSales);
router.get('/sales/:id', validate({ params: v.idParamSchema }), controller.getSale);

router.get('/employees', validate({ query: v.employeesQuery }), controller.listEmployees);
router.patch('/employees/:id/status', validate({ params: v.idParamSchema, body: v.employeeStatusSchema }), controller.setEmployeeStatus);

router.get('/products', validate({ query: v.productsQuery }), controller.listProducts);
router.get('/audit-logs', validate({ query: v.auditQuery }), controller.listAuditLogs);

/* ---- support tickets ---- */
router.get('/tickets/stats', ticketAdmin.stats); // keep above /tickets/:id
router.get('/tickets', validate({ query: tv.adminListQuery }), ticketAdmin.list);
router.get('/tickets/:id', validate({ params: tv.idParamSchema }), ticketAdmin.get);
router.post('/tickets/:id/reply', uploadTicketImages, validate({ params: tv.idParamSchema, body: tv.replySchema }), ticketAdmin.reply);
router.patch('/tickets/:id/status', validate({ params: tv.idParamSchema, body: tv.adminStatusSchema }), ticketAdmin.update);

/* ---- announcements (NEW) ---- */
router.get('/announcements', validate({ query: av.adminListQuery }), announcementAdmin.list);
router.post('/announcements', validate({ body: av.announcementSchema }), announcementAdmin.create);
router.get('/announcements/:id', validate({ params: av.idParamSchema }), announcementAdmin.get);
router.put('/announcements/:id', validate({ params: av.idParamSchema, body: av.announcementSchema }), announcementAdmin.update);
router.patch('/announcements/:id/active', validate({ params: av.idParamSchema, body: av.activeSchema }), announcementAdmin.setActive);
router.delete('/announcements/:id', validate({ params: av.idParamSchema }), announcementAdmin.remove);

module.exports = router;