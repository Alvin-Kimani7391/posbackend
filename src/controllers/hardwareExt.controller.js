const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const tr = require('../services/hardware/transport.service');
const proc = require('../services/hardware/procurement.service');
const boq = require('../services/hardware/boq.service');
const dep = require('../services/hardware/deposit.service');
const tpl = require('../services/hardware/template.service');
const rpk = require('../services/hardware/repack.service');
const fin = require('../services/hardware/finance.service');
const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (r) => r.businessId; const u = (r) => r.user;

module.exports = {
  // fleet + rates + pricing
  listVehicles: h(200, 'Vehicles fetched', async (r) => ({ vehicles: await tr.listVehicles(b(r), r.query) })),
  createVehicle: h(201, 'Vehicle saved', async (r) => ({ vehicle: await tr.saveVehicle(b(r), u(r), null, r.body) })),
  updateVehicle: h(200, 'Vehicle saved', async (r) => ({ vehicle: await tr.saveVehicle(b(r), u(r), r.params.id, r.body) })),
  vehicleAlerts: h(200, 'Vehicle alerts fetched', async (r) => ({ alerts: await tr.vehicleAlerts(b(r), r.query) })),
  listRates: h(200, 'Rates fetched', async (r) => ({ rates: await tr.listRates(b(r), r.query) })),
  createRate: h(201, 'Rate saved', async (r) => ({ rate: await tr.saveRate(b(r), u(r), null, r.body) })),
  updateRate: h(200, 'Rate saved', async (r) => ({ rate: await tr.saveRate(b(r), u(r), r.params.id, r.body) })),
  removeRate: h(200, 'Rate removed', async (r) => tr.removeRate(b(r), u(r), r.params.id)),
  price: h(200, 'Transport price calculated', async (r) => { const p = await tr.priceFor(b(r), r.body); delete p._cents; return p; }),
  // jobs
  assign: h(200, 'Job assigned', async (r) => ({ delivery: await tr.assign(b(r), u(r), r.params.id, r.body) })),
  addJobPayment: h(200, 'Payment recorded', async (r) => ({ delivery: await tr.addPayment(b(r), u(r), r.params.id, r.body) })),
  recordReturn: h(200, 'Return recorded', async (r) => ({ delivery: await tr.recordReturn(b(r), u(r), r.params.id, r.body) })),
  jobSummary: h(200, 'Job profit fetched', async (r) => tr.jobSummary(b(r), r.params.id)),
  addCost: h(201, 'Cost recorded', async (r) => ({ cost: await tr.addCost(b(r), u(r), r.body) })),
  listCosts: h(200, 'Costs fetched', async (r) => tr.listCosts(b(r), u(r), r.query)),
  voidCost: h(200, 'Cost voided', async (r) => ({ cost: await tr.voidCost(b(r), u(r), r.params.id, r.body.reason) })),
  payCost: h(200, 'Cost marked paid', async (r) => ({ cost: await tr.payCost(b(r), u(r), r.params.id, r.body) })),
  transportReport: h(200, 'Transport report fetched', async (r) => tr.report(b(r), u(r), r.query)),
  // supplier + landed
  createSupplierQuote: h(201, 'Supplier quote saved', async (r) => ({ quote: await proc.createQuote(b(r), u(r), r.body) })),
  listSupplierQuotes: h(200, 'Supplier quotes fetched', async (r) => proc.listQuotes(b(r), r.query)),
  setSupplierQuoteStatus: h(200, 'Supplier quote updated', async (r) => ({ quote: await proc.setQuoteStatus(b(r), u(r), r.params.id, r.body.status) })),
  compareSuppliers: h(200, 'Supplier comparison fetched', async (r) => proc.compare(b(r), r.query)),
  priceChanges: h(200, 'Price changes fetched', async (r) => ({ changes: await proc.priceChanges(b(r), r.query) })),
  addLanded: h(201, 'Landed cost saved', async (r) => ({ landedCost: await proc.addLandedCost(b(r), u(r), r.body) })),
  voidLanded: h(200, 'Landed cost voided', async (r) => ({ landedCost: await proc.voidLanded(b(r), u(r), r.params.id, r.body.reason) })),
  landedBreakdown: h(200, 'Landed cost breakdown fetched', async (r) => proc.landedBreakdown(b(r), r.params.purchaseId)),
  // BOQ
  getBoq: h(200, 'BOQ fetched', async (r) => ({ boq: await boq.get(b(r), r.params.projectId) })),
  saveBoq: h(200, 'BOQ saved', async (r) => ({ boq: await boq.save(b(r), u(r), r.params.projectId, r.body) })),
  importBoq: h(200, 'BOQ imported', async (r) => boq.importCsv(b(r), u(r), r.params.projectId, r.body)),
  exportBoq: catchAsync(async (r, res) => { const csv = await boq.exportCsv(r.businessId, r.params.projectId); res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="boq-${r.params.projectId}.csv"`); res.send(csv); }),
  boqStatus: h(200, 'BOQ status fetched', async (r) => boq.status(b(r), r.params.projectId)),
  // deposits
  createDeposit: h(201, 'Deposit recorded', async (r) => ({ deposit: await dep.create(b(r), u(r), r.body) })),
  listDeposits: h(200, 'Deposits fetched', async (r) => dep.list(b(r), r.query)),
  refundDeposit: h(200, 'Deposit refunded', async (r) => ({ deposit: await dep.refund(b(r), u(r), r.params.id, r.body) })),
  depositSummary: h(200, 'Deposit summary fetched', async (r) => dep.summary(b(r), r.params.customerId)),
  // templates, barcode, repack
  listTemplates: h(200, 'Templates fetched', async (r) => ({ templates: await tpl.list(b(r)) })),
  seedTemplates: h(200, 'Starter templates added', async (r) => tpl.seedDefaults(b(r), u(r))),
  createTemplate: h(201, 'Template saved', async (r) => ({ template: await tpl.save(b(r), u(r), null, r.body) })),
  updateTemplate: h(200, 'Template saved', async (r) => ({ template: await tpl.save(b(r), u(r), r.params.id, r.body) })),
  removeTemplate: h(200, 'Template removed', async (r) => tpl.remove(b(r), u(r), r.params.id)),
  lookupBarcode: h(200, 'Barcode matched', async (r) => tpl.lookupBarcode(b(r), r.params.code)),
  repack: h(201, 'Repack recorded', async (r) => rpk.repack(b(r), u(r), r.body)),
  listRepacks: h(200, 'Repacks fetched', async (r) => rpk.list(b(r), r.query)),
  // finance
  financeReport: h(200, 'Operating profit fetched', async (r) => fin.report(b(r), u(r), r.query)),
  classifyExpense: h(200, 'Expense updated', async (r) => ({ expense: await fin.classify(b(r), u(r), r.params.id, r.body) })),
  unpaidBills: h(200, 'Unpaid bills fetched', async (r) => ({ bills: await fin.unpaidBills(b(r), u(r), r.query) })),
  setBudgets: h(200, 'Budget saved', async (r) => fin.setBudgets(b(r), u(r), r.body)),
  budgetVsActual: h(200, 'Budget report fetched', async (r) => fin.budgetVsActual(b(r), u(r), r.query)),
  createRecurring: h(201, 'Recurring expense saved', async (r) => ({ recurring: await fin.createRecurring(b(r), u(r), r.body) })),
  listRecurring: h(200, 'Recurring expenses fetched', async (r) => ({ recurring: await fin.listRecurring(b(r)) })),
  stopRecurring: h(200, 'Recurring expense stopped', async (r) => ({ recurring: await fin.stopRecurring(b(r), u(r), r.params.id) })),
  runRecurring: h(200, 'Recurring expenses run', async (r) => fin.runRecurring(b(r), u(r))),
};
