const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const settings = require('../services/restaurant/settings.service');
const tables = require('../services/restaurant/table.service');
const menu = require('../services/restaurant/menu.service');
const recipes = require('../services/restaurant/recipe.service');
const ing = require('../services/restaurant/ingredient.service');
const orders = require('../services/restaurant/order.service');
const kitchen = require('../services/restaurant/kitchen.service');
const bills = require('../services/restaurant/bill.service');
const resv = require('../services/restaurant/reservation.service');
const staff = require('../services/restaurant/staff.service');
const reports = require('../services/restaurant/report.service');

/** h(status, message, fn) -> express handler. fn(req) returns the response `data` object. */
const ApiError = require('../utils/ApiError');
const h = (status, message, fn) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
const b = (req) => req.businessId; const u = (req) => req.user;

module.exports = {
  // settings, areas, stations
  getSettings: h(200, 'Restaurant settings fetched', async (r) => ({ settings: await settings.getSettings(b(r)) })),
  updateSettings: h(200, 'Restaurant settings updated', async (r) => ({ settings: await settings.updateSettings(b(r), u(r)._id, r.body) })),
  listAreas: h(200, 'Areas fetched', async (r) => ({ areas: await settings.listAreas(b(r), r.query.branchId) })),
  createArea: h(201, 'Area created', async (r) => ({ area: await settings.createArea(b(r), u(r)._id, r.body) })),
  updateArea: h(200, 'Area updated', async (r) => ({ area: await settings.updateArea(b(r), r.params.id, r.body) })),
  removeArea: h(200, 'Area removed', async (r) => ({ area: await settings.removeArea(b(r), r.params.id) })),
  listStations: h(200, 'Stations fetched', async (r) => ({ stations: await settings.listStations(b(r), r.query.branchId) })),
  createStation: h(201, 'Station created', async (r) => ({ station: await settings.createStation(b(r), r.body) })),
  updateStation: h(200, 'Station updated', async (r) => ({ station: await settings.updateStation(b(r), r.params.id, r.body) })),
  removeStation: h(200, 'Station removed', async (r) => ({ station: await settings.removeStation(b(r), r.params.id) })),
  // tables
  floor: h(200, 'Floor fetched', async (r) => ({ tables: await tables.floor(b(r), u(r), r.query) })),
  createTable: h(201, 'Table created', async (r) => ({ table: await tables.createTable(b(r), u(r)._id, r.body) })),
  updateTable: h(200, 'Table updated', async (r) => ({ table: await tables.updateTable(b(r), u(r)._id, r.params.id, r.body) })),
  tableStatus: h(200, 'Table status updated', async (r) => ({ table: await tables.setStatus(b(r), u(r), r.params.id, r.body) })),
  assignTable: h(200, 'Waiter assigned', async (r) => ({ table: await tables.assignWaiter(b(r), u(r), r.params.id, r.body) })),
  combineTables: h(200, 'Tables combined', async (r) => ({ table: await tables.combine(b(r), u(r), r.body) })),
  splitTables: h(200, 'Tables separated', async (r) => ({ table: await tables.split(b(r), u(r), r.params.id) })),
  // menu
  getMenu: h(200, 'Menu fetched', async (r) => menu.getMenu(b(r), u(r), r.query)),
  listGroups: h(200, 'Option groups fetched', async (r) => ({ groups: await menu.listGroups(b(r)) })),
  createGroup: h(201, 'Option group created', async (r) => ({ group: await menu.createGroup(b(r), u(r)._id, r.body) })),
  updateGroup: h(200, 'Option group updated', async (r) => ({ group: await menu.updateGroup(b(r), u(r)._id, r.params.id, r.body) })),
  archiveGroup: h(200, 'Option group removed', async (r) => ({ group: await menu.archiveGroup(b(r), u(r)._id, r.params.id) })),
  listItems: h(200, 'Menu items fetched', async (r) => menu.listItems(b(r), r.query)),
  getItem: h(200, 'Menu item fetched', async (r) => ({ item: await menu.getItem(b(r), r.params.id) })),
  createItem: h(201, 'Menu item created', async (r) => ({ item: await menu.createItem(b(r), u(r)._id, r.body) })),
  uploadItemImage: h(200, 'Image uploaded', async (r) => {
    if (!r.file || !r.file.path) throw ApiError.badRequest('Attach an image in the "image" field', 'NO_FILE');
    return { item: await menu.updateItem(b(r), u(r)._id, r.params.id, { image: r.file.path }) };
  }),
  removeItemImage: h(200, 'Image removed', async (r) => ({ item: await menu.updateItem(b(r), u(r)._id, r.params.id, { image: '' }) })),
  updateItem: h(200, 'Menu item updated', async (r) => ({ item: await menu.updateItem(b(r), u(r)._id, r.params.id, r.body) })),
  archiveItem: h(200, 'Menu item archived', async (r) => ({ item: await menu.archiveItem(b(r), u(r)._id, r.params.id) })),
  soldOut: h(200, 'Availability updated', async (r) => ({ item: await menu.setSoldOut(b(r), u(r), r.params.id, r.body) })),
  priceHistory: h(200, 'Price history fetched', async (r) => ({ history: await menu.priceHistory(b(r), r.params.id) })),
  // recipes
  createRecipe: h(201, 'Recipe saved', async (r) => ({ recipe: await recipes.createVersion(b(r), u(r)._id, r.body) })),
  currentRecipe: h(200, 'Recipe fetched', async (r) => ({ recipe: await recipes.current(b(r), r.query.menuItemId) })),
  recipeHistory: h(200, 'Recipe history fetched', async (r) => ({ versions: await recipes.history(b(r), r.params.id) })),
  recipeCost: h(200, 'Recipe cost fetched', async (r) => recipes.costBreakdown(b(r), r.params.id, r.query)),
  // ingredients
  listIngredients: h(200, 'Ingredients fetched', async (r) => ing.listIngredients(b(r), r.query)),
  createIngredient: h(201, 'Ingredient created', async (r) => ({ ingredient: await ing.createIngredient(b(r), u(r)._id, r.body) })),
  updateIngredient: h(200, 'Ingredient updated', async (r) => ({ ingredient: await ing.updateIngredient(b(r), u(r)._id, r.params.id, r.body) })),
  stock: h(200, 'Ingredient stock fetched', async (r) => ing.listStock(b(r), u(r), r.query)),
  movements: h(200, 'Movements fetched', async (r) => ing.listMovements(b(r), u(r), r.query)),
  receive: h(201, 'Ingredients received', async (r) => ({ purchase: await ing.receivePurchase(b(r), r.body.branchId, u(r), r.body) })),
  purchases: h(200, 'Purchases fetched', async (r) => ing.listPurchases(b(r), r.query, u(r))),
  transfer: h(200, 'Stock transferred', async (r) => ({ transfer: await ing.transfer(b(r), r.body.branchId, u(r), r.body) })),
  recordWaste: h(201, 'Waste recorded', async (r) => ({ waste: await ing.recordWaste(b(r), r.body.branchId, u(r), r.body) })),
  adjust: h(200, 'Stock adjusted', async (r) => ({ result: await ing.adjustStock(b(r), r.body.branchId, u(r), r.body) })),
  startCount: h(201, 'Stock count started', async (r) => ({ count: await ing.startCount(b(r), r.body.branchId, u(r), r.body) })),
  listCounts: h(200, 'Stock counts fetched', async (r) => ing.listCounts(b(r), r.query, u(r))),
  getCount: h(200, 'Stock count fetched', async (r) => ({ count: await ing.getCount(b(r), r.params.id) })),
  submitCount: h(200, 'Stock count submitted', async (r) => ({ count: await ing.submitCount(b(r), u(r), r.params.id, r.body) })),
  approveCount: h(200, 'Stock count approved', async (r) => ({ count: await ing.approveCount(b(r), u(r), r.params.id) })),
  cancelCount: h(200, 'Stock count cancelled', async (r) => ({ count: await ing.cancelCount(b(r), u(r), r.params.id) })),
  expiring: h(200, 'Expiring batches fetched', async (r) => ({ batches: await ing.expiringBatches(b(r), u(r), r.query) })),
  replenishment: h(200, 'Replenishment suggestions fetched', async (r) => ({ suggestions: await ing.replenishmentSuggestions(b(r), u(r), r.query) })),
  // orders
  createOrder: h(201, 'Order opened', async (r) => orders.createOrder(b(r), u(r), r.body)),
  listOrders: h(200, 'Orders fetched', async (r) => orders.listOrders(b(r), u(r), r.query)),
  getOrder: h(200, 'Order fetched', async (r) => orders.getOrder(b(r), u(r), r.params.id)),
  addItems: h(200, 'Items added', async (r) => orders.addItems(b(r), u(r), r.params.id, r.body)),
  updateOrderItem: h(200, 'Item updated', async (r) => ({ order: await orders.updateItem(b(r), u(r), r.params.id, r.params.itemId, r.body) })),
  cancelItem: h(200, 'Item cancelled', async (r) => ({ order: await orders.cancelItem(b(r), u(r), r.params.id, r.params.itemId, r.body) })),
  sendOrder: h(200, 'Order sent', async (r) => orders.sendOrder(b(r), u(r), r.params.id, r.body)),
  fireCourse: h(200, 'Course fired', async (r) => orders.fireCourse(b(r), u(r), r.params.id, r.body)),
  serve: h(200, 'Items served', async (r) => ({ order: await orders.serveItems(b(r), u(r), r.params.id, r.body) })),
  comp: h(200, 'Complimentary items updated', async (r) => ({ order: await orders.compItems(b(r), u(r), r.params.id, r.body) })),
  updateOrder: h(200, 'Order updated', async (r) => ({ order: await orders.updateOrder(b(r), u(r), r.params.id, r.body) })),
  transferOrder: h(200, 'Order moved', async (r) => ({ order: await orders.transferTable(b(r), u(r), r.params.id, r.body) })),
  reassign: h(200, 'Order reassigned', async (r) => ({ order: await orders.reassignWaiter(b(r), u(r), r.params.id, r.body) })),
  mergeOrders: h(200, 'Orders merged', async (r) => ({ order: await orders.mergeOrders(b(r), u(r), r.params.id, r.body) })),
  requestBill: h(200, 'Bill requested', async (r) => ({ order: await orders.requestBill(b(r), u(r), r.params.id) })),
  assistance: h(201, 'Help requested', async (r) => ({ incident: await orders.requestAssistance(b(r), u(r), r.params.id, r.body) })),
  cancelOrder: h(200, 'Order cancelled', async (r) => ({ order: await orders.cancelOrder(b(r), u(r), r.params.id, r.body) })),
  reopenOrder: h(200, 'Order reopened', async (r) => ({ order: await orders.reopenOrder(b(r), u(r), r.params.id, r.body) })),
  assignRider: h(200, 'Rider assigned', async (r) => ({ order: await orders.assignRider(b(r), u(r), r.params.id, r.body) })),
  deliveryStatus: h(200, 'Delivery updated', async (r) => ({ order: await orders.setDeliveryStatus(b(r), u(r), r.params.id, r.body) })),
  collectPickup: h(200, 'Pickup collected', async (r) => ({ order: await orders.collectPickup(b(r), u(r), r.params.id, r.body) })),
  myDeliveries: h(200, 'Deliveries fetched', async (r) => ({ orders: await orders.myDeliveries(b(r), u(r), r.query) })),
  listDeliveries: h(200, 'Deliveries fetched', async (r) => ({ orders: await orders.listDeliveries(b(r), u(r), r.query) })),
  syncBatch: h(200, 'Operations processed', async (r) => ({ results: await orders.syncBatch(b(r), u(r), r.body.ops) })),
  // kitchen
  queue: h(200, 'Kitchen queue fetched', async (r) => ({ tickets: await kitchen.queue(b(r), u(r), r.query) })),
  kitchenItem: h(200, 'Item updated', async (r) => { const x = await kitchen.setItemStatus(b(r), u(r), r.params.orderId, r.params.itemId, r.body.status); return { order: x.order, tickets: x.tickets }; }),
  bump: h(200, 'Ticket updated', async (r) => ({ ticket: await kitchen.bumpTicket(b(r), u(r), r.params.id, r.body.status) })),
  expo: h(200, 'Ticket confirmed', async (r) => ({ ticket: await kitchen.expoConfirm(b(r), u(r), r.params.id) })),
  priority: h(200, 'Priority updated', async (r) => ({ ticket: await kitchen.setPriority(b(r), u(r), r.params.id, r.body.priority) })),
  reprint: h(200, 'Ticket reprinted', async (r) => ({ ticket: await kitchen.reprint(b(r), u(r), r.params.id, r.body) })),
  kitchenStats: h(200, 'Kitchen stats fetched', async (r) => kitchen.stats(b(r), u(r), r.query)),
  // bills
  generateBill: h(201, 'Bill generated', async (r) => ({ bill: await bills.generateBill(b(r), u(r), r.params.id, r.body) })),
  listBills: h(200, 'Bills fetched', async (r) => bills.listBills(b(r), u(r), r.query)),
  getBill: h(200, 'Bill fetched', async (r) => bills.getBill(b(r), u(r), r.params.id)),
  discount: h(200, 'Discount applied', async (r) => ({ bill: await bills.setDiscount(b(r), u(r), r.params.id, r.body) })),
  removeDiscount: h(200, 'Discount removed', async (r) => ({ bill: await bills.removeDiscount(b(r), u(r), r.params.id) })),
  serviceCharge: h(200, 'Service charge updated', async (r) => ({ bill: await bills.waiveServiceCharge(b(r), u(r), r.params.id, r.body) })),
  splitBill: h(200, 'Bill split', async (r) => ({ bills: await bills.splitBill(b(r), u(r), r.params.id, r.body) })),
  moveItems: h(200, 'Items moved', async (r) => bills.moveItems(b(r), u(r), r.params.id, r.body)),
  mergeBills: h(200, 'Bills merged', async (r) => ({ bill: await bills.mergeBills(b(r), u(r), r.body) })),
  voidBill: h(200, 'Bill voided', async (r) => ({ bill: await bills.voidBill(b(r), u(r), r.params.id, r.body) })),
  pay: h(200, 'Payment recorded', async (r) => bills.pay(b(r), u(r), r.params.id, r.body)),
  closeBill: h(200, 'Bill closed', async (r) => { const x = await bills.closeBill(b(r), u(r), r.params.id, r.body); return { bill: x.bill, sale: x.sale, receipt: x.receipt }; }),
  tip: h(201, 'Tip recorded', async (r) => ({ tip: await bills.addTip(b(r), u(r), r.params.id, r.body) })),
  refund: h(200, 'Refund completed', async (r) => bills.refundBill(b(r), u(r), r.params.id, r.body)),
  mpesaStk: h(200, 'STK push sent', async (r) => bills.mpesaStk(b(r), u(r), r.params.id, r.body)),
  mpesaManual: h(200, 'Till payment request created', async (r) => bills.mpesaManual(b(r), u(r), r.params.id, r.body)),
  mpesaStatus: h(200, 'M-PESA status fetched', async (r) => bills.mpesaStatus(b(r), r.params.reference)),
  mpesaClaim: h(200, 'M-PESA payment claimed', async (r) => bills.mpesaClaim(b(r), u(r), r.params.reference, r.body.receiptCode)),
  mpesaCancel: h(200, 'M-PESA request cancelled', async (r) => bills.mpesaCancel(b(r), r.params.reference)),
  // reservations
  createReservation: h(201, 'Reservation saved', async (r) => ({ reservation: await resv.create(b(r), u(r), r.body) })),
  listReservations: h(200, 'Reservations fetched', async (r) => resv.list(b(r), u(r), r.query)),
  getReservation: h(200, 'Reservation fetched', async (r) => ({ reservation: await resv.get(b(r), r.params.id) })),
  updateReservation: h(200, 'Reservation updated', async (r) => ({ reservation: await resv.update(b(r), u(r), r.params.id, r.body) })),
  reservationStatus: h(200, 'Reservation updated', async (r) => ({ reservation: await resv.setStatus(b(r), u(r), r.params.id, r.body) })),
  deposit: h(200, 'Deposit recorded', async (r) => ({ reservation: await resv.recordDeposit(b(r), u(r), r.params.id, r.body) })),
  settleDeposit: h(200, 'Deposit settled', async (r) => ({ reservation: await resv.settleDeposit(b(r), u(r), r.params.id, r.body) })),
  availability: h(200, 'Availability fetched', async (r) => resv.availability(b(r), u(r), r.query)),
  // staff
  schedule: h(201, 'Shift scheduled', async (r) => ({ shift: await staff.schedule(b(r), u(r), r.body) })),
  listShifts: h(200, 'Shifts fetched', async (r) => staff.listShifts(b(r), u(r), r.query)),
  clockIn: h(200, 'You are on duty', async (r) => ({ shift: await staff.clockIn(b(r), u(r), r.body) })),
  clockOut: h(200, 'You are off duty', async (r) => ({ shift: await staff.clockOut(b(r), u(r), r.body) })),
  availabilityMe: h(200, 'Availability updated', async (r) => ({ shift: await staff.setAvailability(b(r), u(r), r.body) })),
  onDuty: h(200, 'On-duty staff fetched', async (r) => ({ staff: await staff.onDuty(b(r), u(r), r.query) })),
  handover: h(200, 'Handover complete', async (r) => staff.handover(b(r), u(r), r.body)),
  listTips: h(200, 'Tips fetched', async (r) => staff.listTips(b(r), u(r), r.query)),
  allocateTips: h(200, 'Tips allocated', async (r) => staff.allocateTips(b(r), u(r), r.body)),
  payoutTips: h(200, 'Tips paid out', async (r) => staff.payoutTips(b(r), u(r), r.body)),
  tipSummary: h(200, 'Tip summary fetched', async (r) => ({ staff: await staff.tipSummary(b(r), u(r), r.query) })),
  createIncident: h(201, 'Incident recorded', async (r) => ({ incident: await staff.createIncident(b(r), u(r), r.body) })),
  listIncidents: h(200, 'Incidents fetched', async (r) => staff.listIncidents(b(r), u(r), r.query)),
  resolveIncident: h(200, 'Incident resolved', async (r) => ({ incident: await staff.resolveIncident(b(r), u(r), r.params.id, r.body) })),
  listWaste: h(200, 'Waste fetched', async (r) => staff.listWaste(b(r), u(r), r.query)),
  // reports
  dashboard: h(200, 'Dashboard fetched', async (r) => reports.dashboard(b(r), u(r), r.query)),
  repSummary: h(200, 'Summary fetched', async (r) => reports.summary(b(r), u(r), r.query)),
  repSales: h(200, 'Sales fetched', async (r) => ({ rows: await reports.sales(b(r), u(r), r.query) })),
  repFoodCost: h(200, 'Food cost fetched', async (r) => reports.foodCost(b(r), u(r), r.query)),
  repStaff: h(200, 'Staff performance fetched', async (r) => ({ staff: await reports.staff(b(r), u(r), r.query) })),
  repWaste: h(200, 'Waste report fetched', async (r) => reports.waste(b(r), u(r), r.query)),
  repVariance: h(200, 'Stock variance fetched', async (r) => reports.stockVariance(b(r), u(r), r.query)),
  repReconciliation: h(200, 'Reconciliation fetched', async (r) => reports.reconciliation(b(r), u(r), r.query)),
  repDelivery: h(200, 'Delivery report fetched', async (r) => ({ rows: await reports.delivery(b(r), u(r), r.query) })),
};
