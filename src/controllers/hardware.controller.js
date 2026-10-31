const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const prod = require('../services/hardware/product.service');
const quote = require('../services/hardware/quotation.service');
const del = require('../services/hardware/delivery.service');
const rep = require('../services/hardware/hardware-report.service');

const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (r) => r.businessId; const u = (r) => r.user;
const file = (r, f) => r.files && r.files[f] && r.files[f][0] ? r.files[f][0].path : undefined;

module.exports = {
  getSettings: h(200, 'Settings fetched', async (r) => ({ settings: await prod.getSettings(b(r)) })),
  updateSettings: h(200, 'Settings saved', async (r) => ({ settings: await prod.updateSettings(b(r), u(r), r.body) })),

  listProfiles: h(200, 'Products fetched', async (r) => prod.listProfiles(b(r), r.query)),
  getProfile: h(200, 'Product details fetched', async (r) => ({ profile: await prod.getProfile(b(r), r.params.productId) })),
  saveProfile: h(200, 'Product details saved', async (r) => ({ profile: await prod.saveProfile(b(r), u(r), r.params.productId, r.body) })),
  alternatives: h(200, 'Alternatives fetched', async (r) => prod.alternatives(b(r), u(r), r.params.productId, r.query)),
  priceQuote: h(200, 'Prices calculated', async (r) => prod.priceQuote(b(r), r.body)),

  listContractor: h(200, 'Contractor prices fetched', async (r) => ({ prices: await prod.listContractor(b(r), r.query) })),
  createContractor: h(201, 'Contractor price saved', async (r) => ({ price: await prod.saveContractor(b(r), u(r), null, r.body) })),
  updateContractor: h(200, 'Contractor price saved', async (r) => ({ price: await prod.saveContractor(b(r), u(r), r.params.id, r.body) })),
  removeContractor: h(200, 'Contractor price removed', async (r) => prod.removeContractor(b(r), u(r), r.params.id)),

  listLocations: h(200, 'Locations fetched', async (r) => ({ locations: await prod.listLocations(b(r), u(r), r.query) })),
  createLocation: h(201, 'Location saved', async (r) => ({ location: await prod.saveLocation(b(r), u(r), null, r.body) })),
  updateLocation: h(200, 'Location saved', async (r) => ({ location: await prod.saveLocation(b(r), u(r), r.params.id, r.body) })),
  removeLocation: h(200, 'Location removed', async (r) => prod.removeLocation(b(r), r.params.id)),
  pickList: h(200, 'Pick list ready', async (r) => prod.pickList(b(r), u(r), r.body)),
  writeOff: h(201, 'Written off', async (r) => prod.writeOff(b(r), u(r), r.body)),

  listProjects: h(200, 'Projects fetched', async (r) => ({ projects: await prod.listProjects(b(r), r.query) })),
  createProject: h(201, 'Project saved', async (r) => ({ project: await prod.saveProject(b(r), u(r), null, r.body) })),
  updateProject: h(200, 'Project saved', async (r) => ({ project: await prod.saveProject(b(r), u(r), r.params.id, r.body) })),

  listQuotes: h(200, 'Quotations fetched', async (r) => quote.list(b(r), u(r), r.query)),
  createQuote: h(201, 'Quotation created', async (r) => ({ quotation: await quote.create(b(r), u(r), r.body) })),
  getQuote: h(200, 'Quotation fetched', async (r) => ({ quotation: await quote.get(b(r), r.params.id) })),
  updateQuote: h(200, 'Quotation updated', async (r) => ({ quotation: await quote.update(b(r), u(r), r.params.id, r.body) })),
  sendQuote: h(200, 'Quotation sent', async (r) => ({ quotation: await quote.send(b(r), u(r), r.params.id) })),
  approveQuote: h(200, 'Quotation approved', async (r) => quote.approve(b(r), u(r), r.params.id, r.body)),
  rejectQuote: h(200, 'Quotation rejected', async (r) => ({ quotation: await quote.reject(b(r), u(r), r.params.id, r.body.reason) })),
  cancelQuote: h(200, 'Order cancelled', async (r) => ({ quotation: await quote.cancel(b(r), u(r), r.params.id, r.body.reason) })),
  extendQuote: h(200, 'Quotation extended', async (r) => ({ quotation: await quote.extend(b(r), u(r), r.params.id, r.body.days) })),
  convertQuote: h(201, 'Invoice created', async (r) => quote.convert(b(r), r.body.branchId, u(r), r.params.id, r.body)),
  proforma: h(200, 'Pro forma ready', async (r) => quote.proforma(b(r), r.params.id)),
  backorders: h(200, 'Backorders fetched', async (r) => quote.backorders(b(r), r.query)),

  listDeliveries: h(200, 'Deliveries fetched', async (r) => del.list(b(r), u(r), r.query)),
  createDelivery: h(201, 'Delivery scheduled', async (r) => ({ delivery: await del.create(b(r), u(r), r.body) })),
  getDelivery: h(200, 'Delivery fetched', async (r) => ({ delivery: await del.get(b(r), u(r), r.params.id) })),
  updateDelivery: h(200, 'Delivery updated', async (r) => ({ delivery: await del.update(b(r), u(r), r.params.id, r.body) })),
  deliveryStatus: h(200, 'Delivery updated', async (r) => ({ delivery: await del.setStatus(b(r), u(r), r.params.id, r.body.status, r.body) })),
  deliveryOtp: h(200, 'Delivery code issued', async (r) => del.issueOtp(b(r), u(r), r.params.id)),
  deliver: h(200, 'Delivery completed', async (r) => ({ delivery: await del.deliver(b(r), u(r), r.params.id, { ...r.body, photoUrl: file(r, 'photo') || r.body.photoUrl, signatureUrl: file(r, 'signature') || r.body.signatureUrl }) })),

  salesBy: h(200, 'Sales report fetched', async (r) => rep.salesByProduct(b(r), u(r), r.query)),
  contractorProfit: h(200, 'Profitability fetched', async (r) => rep.contractorProfit(b(r), u(r), r.query)),
  slowMaterials: h(200, 'Slow materials fetched', async (r) => rep.slowMaterials(b(r), u(r), r.query)),
  supplierPrices: h(200, 'Supplier price changes fetched', async (r) => rep.supplierPriceChanges(b(r), r.query)),
  pendingDeliveries: h(200, 'Pending deliveries fetched', async (r) => rep.pendingDeliveries(b(r), u(r), r.query)),
  deliveryProfit: h(200, 'Delivery profitability fetched', async (r) => rep.deliveryProfit(b(r), u(r), r.query)),
  credit: h(200, 'Credit balances fetched', async (r) => rep.creditOverdue(b(r))),
  valuation: h(200, 'Stock valuation fetched', async (r) => rep.stockValuation(b(r), u(r), r.query)),
  dashboard: h(200, 'Dashboard fetched', async (r) => rep.dashboard(b(r), u(r), r.query)),
};
