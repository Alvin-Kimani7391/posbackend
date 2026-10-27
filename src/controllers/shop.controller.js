const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const importer = require('../services/shop/import.service');
const held = require('../services/shop/held.service');
const promos = require('../services/shop/promotion.service');
const prices = require('../services/shop/price.service');
const barcodes = require('../services/shop/barcode.service');
const reports = require('../services/shop/shop-report.service');
const onboarding = require('../services/shop/onboarding.service');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (r) => r.businessId; const u = (r) => r.user;
const csvOut = (res, name, csv) => { res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }); return res.send(csv); };

module.exports = {
  // import / export
  importTemplate: catchAsync(async (req, res) => csvOut(res, 'products-template.csv', importer.template())),
  importProducts: h(200, 'Import checked', async (r) => importer.run(b(r), u(r), r.body)),
  importProductsFile: h(200, 'Import checked', async (r) => {
    if (!r.file) throw ApiError.badRequest('Attach the file in the "file" field', 'NO_FILE');
    return importer.run(b(r), u(r), { ...r.body, csv: r.file.buffer.toString('utf8') });
  }),
  exportProducts: catchAsync(async (req, res) => { const { csv } = await importer.exportCsv(b(req), u(req), req.query); return csvOut(res, 'products.csv', csv); }),

  // held sales
  hold: h(201, 'Sale held', async (r) => ({ held: await held.hold(b(r), u(r), r.body) })),
  listHeld: h(200, 'Held sales fetched', async (r) => ({ held: await held.list(b(r), u(r), r.query) })),
  recallHeld: h(200, 'Held sale recalled', async (r) => ({ cart: await held.recall(b(r), u(r), r.params.id) })),
  discardHeld: h(200, 'Held sale discarded', async (r) => { await held.discard(b(r), u(r), r.params.id); return { discarded: true }; }),

  // promotions
  listPromotions: h(200, 'Promotions fetched', async (r) => ({ promotions: await promos.list(b(r), r.query) })),
  activePromotions: h(200, 'Active promotions fetched', async (r) => ({ promotions: (await promos.activeNow(b(r), r.query.branchId)).map(promos.present) })),
  getPromotion: h(200, 'Promotion fetched', async (r) => ({ promotion: await promos.get(b(r), r.params.id) })),
  createPromotion: h(201, 'Promotion created', async (r) => ({ promotion: await promos.create(b(r), u(r), r.body) })),
  updatePromotion: h(200, 'Promotion updated', async (r) => ({ promotion: await promos.update(b(r), u(r), r.params.id, r.body) })),
  pausePromotion: h(200, 'Promotion paused', async (r) => ({ promotion: await promos.setStatus(b(r), u(r), r.params.id, 'PAUSED') })),
  resumePromotion: h(200, 'Promotion resumed', async (r) => ({ promotion: await promos.setStatus(b(r), u(r), r.params.id, 'ACTIVE') })),
  deletePromotion: h(200, 'Promotion deleted', async (r) => promos.remove(b(r), u(r), r.params.id)),
  quote: h(200, 'Offers applied', async (r) => promos.quote(b(r), r.body)),

  // prices
  pricePreview: h(200, 'Price change previewed', async (r) => prices.preview(b(r), r.body)),
  priceApply: h(200, 'Prices updated', async (r) => prices.apply(b(r), u(r), r.body)),
  priceHistory: h(200, 'Price changes fetched', async (r) => prices.history(b(r), r.query)),
  priceBatch: h(200, 'Price change fetched', async (r) => ({ change: await prices.getBatch(b(r), r.params.id) })),
  priceRevert: h(200, 'Price change reverted', async (r) => prices.revert(b(r), u(r), r.params.id)),

  // barcodes
  barcodeGenerate: h(200, 'Barcodes generated', async (r) => barcodes.generate(b(r), u(r), r.body)),
  barcodeLabels: h(200, 'Label data ready', async (r) => ({ labels: await barcodes.labels(b(r), r.body) })),

  // reports
  endOfDay: h(200, 'End-of-day report fetched', async (r) => reports.endOfDay(b(r), u(r), r.query)),
  margins: h(200, 'Margin report fetched', async (r) => reports.margins(b(r), u(r), r.query)),
  deadStock: h(200, 'Dead stock fetched', async (r) => reports.deadStock(b(r), u(r), r.query)),
  stockValuation: h(200, 'Stock valuation fetched', async (r) => reports.stockValuation(b(r), u(r), r.query)),
  reorder: h(200, 'Reorder suggestions fetched', async (r) => reports.reorderSuggestions(b(r), u(r), r.query)),
  creditAging: h(200, 'Credit aging fetched', async (r) => reports.creditAging(b(r), r.query)),
  statement: h(200, 'Statement fetched', async (r) => reports.customerStatement(b(r), r.params.id, r.query)),

  // onboarding
  onboardingStatus: h(200, 'Set-up status fetched', async (r) => onboarding.status(b(r))),
  seedCategories: h(201, 'Categories added', async (r) => onboarding.seedCategories(b(r), u(r), r.body)),
};
