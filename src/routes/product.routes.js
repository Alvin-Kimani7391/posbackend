const router = require('express').Router();
const controller = require('../controllers/product.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');
const {
  createProductSchema,
  updateProductSchema,
  listProductsQuery,
  idParamSchema,
  variantParamSchema,
  barcodeParamSchema,
  skuParamSchema,
  addVariantSchema,
  updateVariantSchema,
} = require('../validators/product.validator');

router.use(authenticate);

// Static lookup routes MUST come before the /:id routes so "barcode"/"sku"
// aren't parsed as a product id.
router.get('/barcode/:barcode', requirePermission('products.view'), validate({ params: barcodeParamSchema }), controller.lookupByBarcode);
router.get('/sku/:sku', requirePermission('products.view'), validate({ params: skuParamSchema }), controller.lookupBySku);

router.get('/', requirePermission('products.view'), validate({ query: listProductsQuery }), controller.list);
router.post('/', requirePermission('products.create'), validate({ body: createProductSchema }), controller.create);
router.get('/:id', requirePermission('products.view'), validate({ params: idParamSchema }), controller.getOne);
router.put('/:id', requirePermission('products.update'), validate({ params: idParamSchema, body: updateProductSchema }), controller.update);
router.delete('/:id', requirePermission('products.delete'), validate({ params: idParamSchema }), controller.remove);

router.post('/:id/variants', requirePermission('products.create'), validate({ params: idParamSchema, body: addVariantSchema }), controller.addVariant);
router.put('/:id/variants/:variantId', requirePermission('products.update'), validate({ params: variantParamSchema, body: updateVariantSchema }), controller.updateVariant);
router.delete('/:id/variants/:variantId', requirePermission('products.delete'), validate({ params: variantParamSchema }), controller.removeVariant);

module.exports = router;
