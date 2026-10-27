/** Wines & spirits. Mounted at /api/v1/liquor. Each part is behind its own feature flag; the sale itself is guarded inside POST /sales. */
const router = require('express').Router();
const c = require('../controllers/liquor.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/liquor.validator');
const id = { params: v.idParam }; const pid = { params: v.productIdParam };

router.use(authenticate);

// ---- policy: licence, hours, dry days, age, empties mode
const comp = requireFeature('liquorCompliance');
router.get('/status', P('sales.create'), c.status); // the till shows "open until 23:00 / closed: dry day" from this
router.get('/settings', comp, P('liquor.settings'), c.getSettings);
router.put('/settings', comp, P('liquor.settings'), validate({ body: v.settingsBody }), c.updateSettings);

// ---- product facts, tots
router.get('/products', P('liquor.products'), validate({ query: v.detailsList }), c.listDetails);
router.get('/products/:productId', P('liquor.products'), validate(pid), c.getDetails);
router.put('/products/:productId', P('liquor.products'), validate({ ...pid, body: v.detailsBody }), c.saveDetails);
router.delete('/products/:productId', P('liquor.products'), validate(pid), c.removeDetails);
const totF = requireFeature('totSales');
router.get('/products/:productId/tot-cost', totF, P('liquor.products'), validate({ ...pid, query: v.totCostQuery }), c.totCost);
router.post('/products/:productId/tot-product', totF, P('liquor.products'), validate({ ...pid, body: v.totProductBody }), c.createTot);

// ---- returnable containers
const emp = requireFeature('emptiesTracking');
router.get('/containers', emp, P('liquor.empties'), c.listContainers);
router.post('/containers', emp, P('liquor.empties'), validate({ body: v.containerCreate }), c.createContainer);
router.put('/containers/:id', emp, P('liquor.empties'), validate({ ...id, body: v.containerUpdate }), c.updateContainer);
router.get('/containers/:id/customers', emp, P('liquor.empties'), validate(id), c.containerCustomers);
router.get('/empties/movements', emp, P('liquor.empties'), validate({ query: v.movementsQuery }), c.movements);
router.post('/empties/refund', emp, P('sales.create'), requireBranchAccess, validate({ body: v.refundBody }), c.refundDeposit);
router.post('/empties/supplier-receive', emp, P('liquor.empties'), validate({ body: v.supplierMoveBody }), c.supplierReceive);
router.post('/empties/supplier-return', emp, P('liquor.empties'), validate({ body: v.supplierMoveBody }), c.supplierReturn);
router.post('/empties/adjust', emp, P('liquor.empties'), validate({ body: v.adjustBody }), c.adjustEmpties);

// ---- open bottles
router.get('/tots/pools', totF, P('liquor.tots'), requireBranchAccess, validate({ query: v.poolsQuery }), c.totPools);
router.post('/tots/count', totF, P('liquor.tots'), requireBranchAccess, validate({ body: v.countBody }), c.totCount);
router.post('/tots/waste', totF, P('liquor.tots'), requireBranchAccess, validate({ body: v.wasteBody }), c.totWaste);
router.get('/tots/variance', totF, P('liquor.reports'), requireBranchAccess, validate({ query: v.range }), c.totVariance);

// ---- reports
router.get('/reports/overview', P('liquor.reports'), requireBranchAccess, validate({ query: v.branchOnly }), c.overview);
router.get('/reports/sales', P('liquor.reports'), requireBranchAccess, validate({ query: v.salesQuery }), c.salesReport);
router.get('/reports/age-checks', P('liquor.reports'), requireBranchAccess, validate({ query: v.checksQuery }), c.ageChecks);
router.get('/reports/overrides', P('liquor.reports'), validate({ query: v.pageRange }), c.overrides);

module.exports = router;
