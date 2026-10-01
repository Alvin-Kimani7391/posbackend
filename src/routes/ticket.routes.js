const router = require('express').Router();
const controller = require('../controllers/ticket.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { uploadTicketImages } = require('../middleware/ticketUpload');
const { idParamSchema, createTicketSchema, replySchema, listTicketsQuery } = require('../validators/ticket.validator');

router.use(authenticate);

router.get('/', requirePermission('tickets.view'), validate({ query: listTicketsQuery }), controller.list);
// multer runs BEFORE validate so the multipart text fields are parsed into req.body first
router.post('/', requirePermission('tickets.create'), uploadTicketImages, validate({ body: createTicketSchema }), controller.create);
router.get('/:id', requirePermission('tickets.view'), validate({ params: idParamSchema }), controller.get);
router.post('/:id/reply', requirePermission('tickets.create'), uploadTicketImages, validate({ params: idParamSchema, body: replySchema }), controller.reply);
router.post('/:id/close', requirePermission('tickets.create'), validate({ params: idParamSchema }), controller.close);

module.exports = router;
