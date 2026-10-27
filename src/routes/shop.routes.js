/** General-shop tools. Mounted at /api/v1/shop. Held sales and promotions are optional features (requireFeature); everything else is available to every business type. */
const router = require('express').Router();
const c = require('../controllers/shop.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const csvUpload = require('../middleware/csvUpload');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/shop.validator');
const id = { params: v.idParam };

router.use(authenticate);

// ---- set-up
router.get('/onboarding', P('shop.onboarding.manage'), c.onboardingStatus);
router.post('/onboarding/starter-categories', P('shop.onboarding.manage'), validate({ body: v.seedCategoriesBody }), c.seedCategories);

// ---- product import / export (always dry-run first)
router.get('/import/template', P('shop.import'), c.importTemplate);
router.post('/import', P('shop.import'), validate({ body: v.importBody }), c.importProducts);
router.post('/import/file', P('shop.import'), csvUpload, validate({ body: v.importFileForm }), c.importProductsFile);
router.get('/export', P('shop.import'), validate({ query: v.exportQuery }), c.exportProducts);

// ---- held sales
const held = requireFeature('heldSales');
router.get('/held', held, P('shop.held.use'), validate({ query: v.heldListQuery }), c.listHeld);
router.post('/held', held, P('shop.held.use'), requireBranchAccess, validate({ body: v.heldBody }), c.hold);
router.post('/held/:id/recall', held, P('shop.held.use'), validate(id), c.recallHeld);
router.delete('/held/:id', held, P('shop.held.use'), validate(id), c.discardHeld);

// ---- promotions
const promo = requireFeature('promotions');
router.get('/promotions/active', promo, P('shop.promotions.view'), validate({ query: v.branchOnly }), c.activePromotions);
router.post('/promotions/quote', promo, P('shop.promotions.view'), validate({ body: v.quoteBody }), c.quote);
router.get('/promotions', promo, P('shop.promotions.manage'), validate({ query: v.promoListQuery }), c.listPromotions);
router.post('/promotions', promo, P('shop.promotions.manage'), validate({ body: v.promotionCreate }), c.createPromotion);
router.get('/promotions/:id', promo, P('shop.promotions.manage'), validate(id), c.getPromotion);
router.put('/promotions/:id', promo, P('shop.promotions.manage'), validate({ ...id, body: v.promotionUpdate }), c.updatePromotion);
router.post('/promotions/:id/pause', promo, P('shop.promotions.manage'), validate(id), c.pausePromotion);
router.post('/promotions/:id/resume', promo, P('shop.promotions.manage'), validate(id), c.resumePromotion);
router.delete('/promotions/:id', promo, P('shop.promotions.manage'), validate(id), c.deletePromotion);

// ---- bulk prices
router.post('/prices/preview', P('shop.prices.manage'), validate({ body: v.priceBody }), c.pricePreview);
router.post('/prices/apply', P('shop.prices.manage'), validate({ body: v.priceBody }), c.priceApply);
router.get('/prices/history', P('shop.prices.manage'), validate({ query: v.historyQuery }), c.priceHistory);
router.get('/prices/history/:id', P('shop.prices.manage'), validate(id), c.priceBatch);
router.post('/prices/history/:id/revert', P('shop.prices.manage'), validate(id), c.priceRevert);

// ---- barcodes + labels
router.post('/barcodes/generate', P('shop.barcodes.manage'), validate({ body: v.barcodeGenBody }), c.barcodeGenerate);
router.post('/barcodes/labels', P('shop.barcodes.manage'), validate({ body: v.labelBody }), c.barcodeLabels);

// ---- reports
router.get('/reports/end-of-day', P('shop.reports.view'), requireBranchAccess, validate({ query: v.eodQuery }), c.endOfDay);
router.get('/reports/margins', P('shop.reports.view'), requireBranchAccess, validate({ query: v.marginQuery }), c.margins);
router.get('/reports/dead-stock', P('shop.reports.view'), requireBranchAccess, validate({ query: v.deadQuery }), c.deadStock);
router.get('/reports/stock-valuation', P('shop.reports.view'), requireBranchAccess, validate({ query: v.branchOnly }), c.stockValuation);
router.get('/reports/reorder', P('shop.reports.view'), requireBranchAccess, validate({ query: v.reorderQuery }), c.reorder);
router.get('/reports/credit-aging', P('shop.reports.view'), validate({ query: v.agingQuery }), c.creditAging);
router.get('/reports/customer-statement/:id', P('shop.reports.view'), validate({ ...id, query: v.statementQuery }), c.statement);

module.exports = router;
