/** Hardware & building materials. Mounted at /api/v1/hardware. */
const router = require('express').Router();
const c = require('../controllers/hardware.controller');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const { hasPermission } = require('../utils/permissionCheck');
const { ApiError } = { ApiError: require('../utils/ApiError') };
const { uploadDeliveryProof } = require('../middleware/hospitalityUpload');
const v = require('../validators/hardware.validator');
const id = { params: v.idParam }; const pid = { params: v.productIdParam };
const anyOf = (...perms) => (req, res, next) => (perms.some((p) => hasPermission(req.user, p)) ? next() : next(ApiError.forbidden(`Missing permission: ${perms.join(' or ')}`, 'PERMISSION_DENIED')));

router.use(authenticate);

router.get('/settings', P('hardware.settings'), c.getSettings);
router.put('/settings', P('hardware.settings'), validate({ body: v.settingsBody }), c.updateSettings);
router.get('/dashboard', P('hardware.reports'), requireBranchAccess, validate({ query: v.branchOnly }), c.dashboard);

// ---- product facts, alternatives, price quote
router.get('/products', P('hardware.profile'), validate({ query: v.profilesQuery }), c.listProfiles);
router.get('/products/:productId', anyOf('hardware.profile', 'hardware.quotes'), validate(pid), c.getProfile);
router.put('/products/:productId', P('hardware.profile'), validate({ ...pid, body: v.profileBody }), c.saveProfile);
router.get('/products/:productId/alternatives', anyOf('hardware.profile', 'hardware.quotes'), requireBranchAccess, validate({ ...pid, query: v.altQuery }), c.alternatives);
router.post('/price-quote', anyOf('hardware.quotes', 'sales.create'), validate({ body: v.priceQuoteBody }), c.priceQuote);

// ---- contractor prices
const cp = requireFeature('contractorPricing');
router.get('/contractor-prices', cp, P('hardware.pricing'), validate({ query: v.contractorQuery }), c.listContractor);
router.post('/contractor-prices', cp, P('hardware.pricing'), validate({ body: v.contractorBody }), c.createContractor);
router.put('/contractor-prices/:id', cp, P('hardware.pricing'), validate({ ...id, body: v.contractorUpdate }), c.updateContractor);
router.delete('/contractor-prices/:id', cp, P('hardware.pricing'), validate(id), c.removeContractor);

// ---- locations, pick list, write-offs
const wl = requireFeature('warehouseLocations');
router.get('/locations', wl, P('hardware.locations'), requireBranchAccess, validate({ query: v.locationQuery }), c.listLocations);
router.post('/locations', wl, P('hardware.locations'), requireBranchAccess, validate({ body: v.locationBody }), c.createLocation);
router.put('/locations/:id', wl, P('hardware.locations'), requireBranchAccess, validate({ ...id, body: v.locationBody }), c.updateLocation);
router.delete('/locations/:id', wl, P('hardware.locations'), validate(id), c.removeLocation);
router.post('/pick-list', wl, P('hardware.locations'), requireBranchAccess, validate({ body: v.pickBody }), c.pickList);
router.post('/write-offs', P('hardware.remnants'), requireBranchAccess, validate({ body: v.writeOffBody }), c.writeOff);

// ---- projects
router.get('/projects', P('hardware.quotes'), validate({ query: v.projectQuery }), c.listProjects);
router.post('/projects', P('hardware.quotes'), validate({ body: v.projectBody }), c.createProject);
router.put('/projects/:id', P('hardware.quotes'), validate({ ...id, body: v.projectUpdate }), c.updateProject);

// ---- quotations -> orders -> invoices
const qm = requireFeature('quotationManagement');
router.get('/quotations', qm, P('hardware.quotes'), validate({ query: v.quotesQuery }), c.listQuotes);
router.get('/quotations/backorders', qm, P('hardware.quotes'), requireBranchAccess, validate({ query: v.backorderQuery }), c.backorders);
router.post('/quotations', qm, P('hardware.quotes'), requireBranchAccess, validate({ body: v.quoteBody }), c.createQuote);
router.get('/quotations/:id', qm, P('hardware.quotes'), validate(id), c.getQuote);
router.put('/quotations/:id', qm, P('hardware.quotes'), validate({ ...id, body: v.quoteUpdate }), c.updateQuote);
router.get('/quotations/:id/proforma', qm, P('hardware.quotes'), validate(id), c.proforma);
router.post('/quotations/:id/send', qm, P('hardware.quotes'), validate(id), c.sendQuote);
router.post('/quotations/:id/approve', qm, P('hardware.quotes.approve'), validate({ ...id, body: v.approveBody }), c.approveQuote);
router.post('/quotations/:id/reject', qm, P('hardware.quotes'), validate({ ...id, body: v.reasonBody }), c.rejectQuote);
router.post('/quotations/:id/cancel', qm, P('hardware.quotes.approve'), validate({ ...id, body: v.reasonBody }), c.cancelQuote);
router.post('/quotations/:id/extend', qm, P('hardware.quotes'), validate({ ...id, body: v.extendBody }), c.extendQuote);
router.post('/quotations/:id/convert', qm, P('sales.create'), requireBranchAccess, validate({ ...id, body: v.convertBody }), c.convertQuote);

// ---- deliveries (dispatcher sees all, a driver only their own)
const dm = requireFeature('deliveryManagement');
const dAny = anyOf('hardware.deliveries', 'hardware.deliver');
router.get('/deliveries', dm, dAny, requireBranchAccess, validate({ query: v.deliveriesQuery }), c.listDeliveries);
router.post('/deliveries', dm, P('hardware.deliveries'), requireBranchAccess, validate({ body: v.deliveryBody }), c.createDelivery);
router.get('/deliveries/:id', dm, dAny, validate(id), c.getDelivery);
router.put('/deliveries/:id', dm, P('hardware.deliveries'), validate({ ...id, body: v.deliveryUpdate }), c.updateDelivery);
router.post('/deliveries/:id/status', dm, dAny, validate({ ...id, body: v.statusBody }), c.deliveryStatus);
router.post('/deliveries/:id/otp', dm, P('hardware.deliveries'), validate(id), c.deliveryOtp);
router.post('/deliveries/:id/deliver', dm, dAny, uploadDeliveryProof, validate({ ...id, body: v.deliverBody }), c.deliver);

// ---- reports
const R = [P('hardware.reports'), requireBranchAccess];
router.get('/reports/sales', ...R, validate({ query: v.salesQuery }), c.salesBy);
router.get('/reports/contractors', ...R, validate({ query: v.range }), c.contractorProfit);
router.get('/reports/slow-materials', ...R, validate({ query: v.slowQuery }), c.slowMaterials);
router.get('/reports/supplier-prices', ...R, validate({ query: v.limitQuery }), c.supplierPrices);
router.get('/reports/pending-deliveries', ...R, validate({ query: v.branchOnly }), c.pendingDeliveries);
router.get('/reports/delivery-profit', ...R, validate({ query: v.range }), c.deliveryProfit);
router.get('/reports/credit', ...R, c.credit);
router.get('/reports/stock-value', ...R, validate({ query: v.branchOnly }), c.valuation);

// =====================================================================================
// Transport, supplier quotes, BOQ, deposits, templates, repack, finance
// =====================================================================================
const x = require('../controllers/hardwareExt.controller'); const e = require('../validators/hardwareExt.validator');
const tm = requireFeature('transportManagement');

// ---- fleet, rate card, transport price
router.get('/transport/vehicles', tm, P('hardware.transport'), validate({ query: e.vehicleQuery }), x.listVehicles);
router.get('/transport/vehicles/alerts', tm, P('hardware.transport'), validate({ query: e.alertQuery }), x.vehicleAlerts);
router.post('/transport/vehicles', tm, P('hardware.transport.manage'), validate({ body: e.vehicleBody }), x.createVehicle);
router.put('/transport/vehicles/:id', tm, P('hardware.transport.manage'), validate({ params: e.idParam, body: e.vehicleUpdate }), x.updateVehicle);
router.get('/transport/rates', tm, P('hardware.transport'), validate({ query: e.rateQuery }), x.listRates);
router.post('/transport/rates', tm, P('hardware.transport.manage'), validate({ body: e.rateBody }), x.createRate);
router.put('/transport/rates/:id', tm, P('hardware.transport.manage'), validate({ params: e.idParam, body: e.rateUpdate }), x.updateRate);
router.delete('/transport/rates/:id', tm, P('hardware.transport.manage'), validate({ params: e.idParam }), x.removeRate);
router.post('/transport/price', tm, anyOf('hardware.transport', 'hardware.deliveries'), validate({ body: v.pricingReq }), x.price);

// ---- job assignment, costs, payments, trip log, profit
router.post('/deliveries/:id/assign', tm, P('hardware.deliveries'), validate({ params: e.idParam, body: e.assignBody }), x.assign);
router.post('/deliveries/:id/payments', tm, anyOf('hardware.deliveries', 'hardware.deposits'), validate({ params: e.idParam, body: e.jobPaymentBody }), x.addJobPayment);
router.post('/deliveries/:id/return', tm, dAny, validate({ params: e.idParam, body: e.returnBody }), x.recordReturn);
router.get('/deliveries/:id/profit', tm, anyOf('hardware.transport', 'hardware.deliveries'), validate({ params: e.idParam }), x.jobSummary);
router.get('/transport/costs', tm, P('hardware.transport'), requireBranchAccess, validate({ query: e.costQuery }), x.listCosts);
router.post('/transport/costs', tm, anyOf('hardware.transport.costs', 'hardware.transport.manage'), validate({ body: e.costBody }), x.addCost);
router.post('/transport/costs/:id/void', tm, P('hardware.transport.manage'), validate({ params: e.idParam, body: e.voidBody }), x.voidCost);
router.post('/transport/costs/:id/pay', tm, P('hardware.transport.manage'), validate({ params: e.idParam, body: e.payCostBody }), x.payCost);
router.get('/reports/transport', tm, ...R, validate({ query: e.range }), x.transportReport);

// ---- supplier quotations, comparison, price changes, landed costs
router.get('/supplier-quotes', P('hardware.supplier'), validate({ query: e.quoteQuery }), x.listSupplierQuotes);
router.get('/supplier-quotes/compare', P('hardware.supplier'), validate({ query: e.compareQuery }), x.compareSuppliers);
router.post('/supplier-quotes', P('hardware.supplier'), validate({ body: e.quoteBody }), x.createSupplierQuote);
router.post('/supplier-quotes/:id/status', P('hardware.supplier'), validate({ params: e.idParam, body: e.quoteStatusBody }), x.setSupplierQuoteStatus);
router.get('/reports/purchase-price-changes', ...R, validate({ query: e.priceChangeQuery }), x.priceChanges);
router.post('/landed-costs', P('hardware.supplier'), validate({ body: e.landedBody }), x.addLanded);
router.post('/landed-costs/:id/void', P('hardware.supplier'), validate({ params: e.idParam, body: e.voidBody }), x.voidLanded);
router.get('/purchases/:purchaseId/landed', P('hardware.supplier'), validate({ params: e.purchaseParam }), x.landedBreakdown);

// ---- bill of quantities
router.get('/projects/:projectId/boq', P('hardware.boq'), validate({ params: e.projectParam }), x.getBoq);
router.put('/projects/:projectId/boq', P('hardware.boq'), validate({ params: e.projectParam, body: e.boqBody }), x.saveBoq);
router.post('/projects/:projectId/boq/import', P('hardware.boq'), validate({ params: e.projectParam, body: e.boqImport }), x.importBoq);
router.get('/projects/:projectId/boq/export', P('hardware.boq'), validate({ params: e.projectParam }), x.exportBoq);
router.get('/projects/:projectId/boq/status', anyOf('hardware.boq', 'hardware.reports'), validate({ params: e.projectParam }), x.boqStatus);

// ---- customer deposits and part-payments
router.get('/deposits', P('hardware.deposits'), validate({ query: e.depositQuery }), x.listDeposits);
router.post('/deposits', P('hardware.deposits'), requireBranchAccess, validate({ body: e.depositBody }), x.createDeposit);
router.post('/deposits/:id/refund', P('hardware.deposits.refund'), validate({ params: e.idParam, body: e.depositRefund }), x.refundDeposit);
router.get('/customers/:customerId/deposits', P('hardware.deposits'), validate({ params: e.customerParam }), x.depositSummary);

// ---- templates, barcode lookup, repack
router.get('/templates', anyOf('hardware.profile', 'hardware.templates'), x.listTemplates);
router.post('/templates/seed', P('hardware.templates'), x.seedTemplates);
router.post('/templates', P('hardware.templates'), validate({ body: e.templateBody }), x.createTemplate);
router.put('/templates/:id', P('hardware.templates'), validate({ params: e.idParam, body: e.templateUpdate }), x.updateTemplate);
router.delete('/templates/:id', P('hardware.templates'), validate({ params: e.idParam }), x.removeTemplate);
router.get('/barcode/:code', anyOf('sales.create', 'hardware.profile', 'hardware.quotes'), validate({ params: e.barcodeParam }), x.lookupBarcode);
router.post('/repack', P('hardware.repack'), requireBranchAccess, validate({ body: e.repackBody }), x.repack);
router.get('/repack', P('hardware.repack'), requireBranchAccess, validate({ query: e.repackQuery }), x.listRepacks);

// ---- finance: operating profit, expense classification, budgets, recurring
router.get('/reports/operating-profit', P('hardware.finance'), requireBranchAccess, validate({ query: e.range }), x.financeReport);
router.put('/expenses/:id/classify', P('hardware.finance'), validate({ params: e.idParam, body: e.classifyBody }), x.classifyExpense);
router.get('/expenses/unpaid', P('hardware.finance'), requireBranchAccess, validate({ query: e.branchOnly }), x.unpaidBills);
router.put('/budgets', P('hardware.finance'), validate({ body: e.budgetBody }), x.setBudgets);
router.get('/budgets', P('hardware.finance'), validate({ query: e.budgetQuery }), x.budgetVsActual);
router.get('/recurring-expenses', P('hardware.finance'), x.listRecurring);
router.post('/recurring-expenses', P('hardware.finance'), requireBranchAccess, validate({ body: e.recurringBody }), x.createRecurring);
router.post('/recurring-expenses/run', P('hardware.finance'), x.runRecurring);
router.post('/recurring-expenses/:id/stop', P('hardware.finance'), validate({ params: e.idParam }), x.stopRecurring);

module.exports = router;
