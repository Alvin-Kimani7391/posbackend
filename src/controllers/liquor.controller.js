const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const settings = require('../services/liquor/settings.service');
const details = require('../services/liquor/details.service');
const empties = require('../services/liquor/empties.service');
const tots = require('../services/liquor/tots.service');
const reports = require('../services/liquor/liquor-report.service');
const till = require('../services/liquor/till.service');
const { fromCents } = require('../utils/money');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (r) => r.businessId; const u = (r) => r.user;

module.exports = {
  getSettings: h(200, 'Liquor settings fetched', async (r) => ({ settings: await settings.get(b(r)) })),
  updateSettings: h(200, 'Liquor settings saved', async (r) => ({ settings: await settings.update(b(r), u(r), r.body) })),
  status: h(200, 'Status fetched', async (r) => settings.status(b(r))),
  tillContext: h(200, 'Till data fetched', async (r) => till.context(b(r))),

  listDetails: h(200, 'Liquor products fetched', async (r) => details.list(b(r), r.query)),
  getDetails: h(200, 'Liquor details fetched', async (r) => ({ details: await details.get(b(r), r.params.productId) })),
  saveDetails: h(200, 'Liquor details saved', async (r) => ({ details: await details.upsert(b(r), u(r), r.params.productId, r.body) })),
  removeDetails: h(200, 'Liquor details removed', async (r) => details.remove(b(r), u(r), r.params.productId)),
  totCost: h(200, 'Tot pricing fetched', async (r) => { const x = await details.totCost(b(r), r.params.productId, r.query.ml); return { costPerTot: fromCents(x.costPerTot), suggestedPrice: fromCents(x.suggestedPrice), totsPerBottle: x.totsPerBottle, bottleVolumeMl: x.volumeMl }; }),
  createTot: h(201, 'Tot product created', async (r) => details.createTotProduct(b(r), u(r), r.params.productId, r.body)),

  listContainers: h(200, 'Containers fetched', async (r) => ({ containers: await empties.list(b(r)) })),
  createContainer: h(201, 'Container created', async (r) => ({ container: await empties.createType(b(r), u(r), r.body) })),
  updateContainer: h(200, 'Container updated', async (r) => ({ container: await empties.updateType(b(r), u(r), r.params.id, r.body) })),
  containerCustomers: h(200, 'Customers owing empties fetched', async (r) => ({ customers: await empties.customerBalances(b(r), r.params.id) })),
  movements: h(200, 'Container movements fetched', async (r) => empties.movements(b(r), r.query)),
  refundDeposit: h(201, 'Deposit refunded', async (r) => empties.refundDeposit(b(r), u(r), r.body)),
  supplierReceive: h(201, 'Recorded', async (r) => ({ movement: await empties.supplierReceive(b(r), u(r), r.body) })),
  supplierReturn: h(201, 'Recorded', async (r) => ({ movement: await empties.supplierReturn(b(r), u(r), r.body) })),
  adjustEmpties: h(200, 'Empties adjusted', async (r) => ({ container: await empties.adjust(b(r), u(r), r.body) })),

  totPools: h(200, 'Open bottles fetched', async (r) => ({ pools: await tots.pools(b(r), u(r), r.query) })),
  totCount: h(201, 'Dip count recorded', async (r) => tots.count(b(r), u(r), r.body)),
  totWaste: h(201, 'Pour recorded', async (r) => tots.wasteOrComp(b(r), u(r), r.body)),
  totVariance: h(200, 'Tot variance fetched', async (r) => tots.variance(b(r), u(r), r.query)),

  overview: h(200, 'Overview fetched', async (r) => reports.overview(b(r), u(r), r.query)),
  salesReport: h(200, 'Liquor sales fetched', async (r) => reports.sales(b(r), u(r), r.query)),
  ageChecks: h(200, 'Age checks fetched', async (r) => reports.ageChecks(b(r), u(r), r.query)),
  overrides: h(200, 'Overrides fetched', async (r) => reports.overrides(b(r), r.query)),
};
