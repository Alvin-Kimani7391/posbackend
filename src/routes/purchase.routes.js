const router = require('express').Router();
const controller = require('../controllers/purchase.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const { uploadPurchaseInvoices } = require('../middleware/purchaseUpload');
const parseJsonFields = require('../middleware/parseJsonFields');
const { createPurchaseSchema, listPurchasesQuery, recordPaymentSchema, idParamSchema } = require('../validators/purchase.validator');

router.use(authenticate);

/**
 * Changing a product's cost/selling price/discount from a purchase is a
 * product edit, so it needs 'products.update' - but ONLY when the request
 * actually asks for a price update. Plain purchases are unaffected.
 */
const requireProductUpdateIfPricing = (req, res, next) => {
  const wantsPriceUpdate = Array.isArray(req.body.items) && req.body.items.some((i) => i.updatePrices);
  return wantsPriceUpdate ? requirePermission('products.update')(req, res, next) : next();
};

router.get('/', requirePermission('purchases.view'), validate({ query: listPurchasesQuery }), controller.list);
router.post(
  '/',
  requirePermission('purchases.create'),
  uploadPurchaseInvoices,      // multer first so multipart fields land in req.body
  parseJsonFields('items'),    // items arrives as a JSON string
  validate({ body: createPurchaseSchema }),
  requireProductUpdateIfPricing,
  controller.create
);
router.get('/:id', requirePermission('purchases.view'), validate({ params: idParamSchema }), controller.getOne);
router.post('/:id/receive', requirePermission('purchases.receive'), validate({ params: idParamSchema }), controller.receive);
router.post('/:id/payments', requirePermission('purchases.pay'), validate({ params: idParamSchema, body: recordPaymentSchema }), controller.recordPayment);

module.exports = router;