/**
 * Restaurant module. Mounted at /api/v1/restaurant.
 * Four independent checks on every route: authenticate (tenant), requireFeature (module enabled for THIS business),
 * requirePermission (this user), and tenant/branch/own-order scoping inside the services.
 */
const router = require('express').Router();
const c = require('../controllers/restaurant.controller');
const validate = require('../middleware/validate');
const idempotent = require('../middleware/idempotency');
const requireFeature = require('../middleware/requireFeature');
const { authenticate, requirePermission: P, requireBranchAccess } = require('../middleware/auth');
const v = require('../validators/restaurant.validator');
const { uploadMenuImage } = require('../middleware/hospitalityUpload');

router.use(authenticate, requireFeature('restaurantOrdering'));
const tbl = requireFeature('tableManagement'); const kds = requireFeature('kitchenDisplay'); const rcp = requireFeature('recipeManagement'); const rsv = requireFeature('reservations');
const id = { params: v.idParam };

// ---- settings, areas, stations
router.get('/storefront/qr', P('restaurant.guest.qr'), c.storeQr);
router.post('/storefront/qr/rotate', P('restaurant.guest.qr'), c.storeQrRotate);
router.get('/settings', P('restaurant.settings.view'), c.getSettings);
router.put('/settings', P('restaurant.settings.manage'), validate({ body: v.settingsSchema }), c.updateSettings);
router.get('/areas', tbl, P('restaurant.tables.view'), validate({ query: v.branchQ }), c.listAreas);
router.post('/areas', tbl, P('restaurant.tables.manage'), validate({ body: v.areaBody }), requireBranchAccess, c.createArea);
router.put('/areas/:id', tbl, P('restaurant.tables.manage'), validate({ ...id, body: v.areaUpdate }), c.updateArea);
router.delete('/areas/:id', tbl, P('restaurant.tables.manage'), validate(id), c.removeArea);
router.get('/stations', P('restaurant.menu.view'), validate({ query: v.branchQ }), c.listStations);
router.post('/stations', P('restaurant.settings.manage'), validate({ body: v.stationBody }), requireBranchAccess, c.createStation);
router.put('/stations/:id', P('restaurant.settings.manage'), validate({ ...id, body: v.stationUpdate }), c.updateStation);
router.delete('/stations/:id', P('restaurant.settings.manage'), validate(id), c.removeStation);

// ---- tables
router.get('/tables', tbl, P('restaurant.tables.view'), validate({ query: v.floorQuery }), requireBranchAccess, c.floor);
router.post('/tables', tbl, P('restaurant.tables.manage'), validate({ body: v.tableBody }), requireBranchAccess, c.createTable);
router.post('/tables/combine', tbl, P('restaurant.tables.manage'), validate({ body: v.combineBody }), c.combineTables);
router.put('/tables/:id', tbl, P('restaurant.tables.manage'), validate({ ...id, body: v.tableUpdate }), c.updateTable);
router.post('/tables/:id/status', tbl, P('restaurant.tables.assign'), validate({ ...id, body: v.tableStatus }), c.tableStatus);
router.post('/tables/:id/assign', tbl, P('restaurant.tables.assign'), validate({ ...id, body: v.assignBody }), c.assignTable);
router.post('/tables/:id/split', tbl, P('restaurant.tables.manage'), validate(id), c.splitTables);

// ---- menu
router.get('/menu', P('restaurant.menu.view'), validate({ query: v.menuQuery }), requireBranchAccess, c.getMenu);
router.get('/menu/groups', P('restaurant.menu.view'), c.listGroups);
router.post('/menu/groups', P('restaurant.menu.manage'), validate({ body: v.groupBody }), c.createGroup);
router.put('/menu/groups/:id', P('restaurant.menu.manage'), validate({ ...id, body: v.groupBody.partial() }), c.updateGroup);
router.delete('/menu/groups/:id', P('restaurant.menu.manage'), validate(id), c.archiveGroup);
router.get('/menu/items', P('restaurant.menu.view'), validate({ query: v.itemListQuery }), c.listItems);
router.post('/menu/items', P('restaurant.menu.manage'), validate({ body: v.itemCreate }), c.createItem);
router.get('/menu/items/:id', P('restaurant.menu.view'), validate(id), c.getItem);
router.put('/menu/items/:id', P('restaurant.menu.manage'), validate({ ...id, body: v.itemUpdate }), c.updateItem);
router.post('/menu/items/:id/image', P('restaurant.menu.manage'), validate(id), uploadMenuImage, c.uploadItemImage);
router.delete('/menu/items/:id/image', P('restaurant.menu.manage'), validate(id), c.removeItemImage);
router.delete('/menu/items/:id', P('restaurant.menu.manage'), validate(id), c.archiveItem);
router.post('/menu/items/:id/sold-out', P('restaurant.menu.soldout'), validate({ ...id, body: v.soldOutBody }), c.soldOut);
router.get('/menu/items/:id/price-history', P('restaurant.menu.manage'), validate(id), c.priceHistory);

// ---- recipes and ingredients
router.get('/recipes', rcp, P('restaurant.recipes.view'), validate({ query: v.recipeQuery }), c.currentRecipe);
router.post('/recipes', rcp, P('restaurant.recipes.manage'), validate({ body: v.recipeBody }), c.createRecipe);
router.get('/recipes/:id/history', rcp, P('restaurant.recipes.view'), validate(id), c.recipeHistory);
router.get('/recipes/:id/cost', rcp, P('restaurant.recipes.view'), validate({ ...id, query: v.costQuery }), c.recipeCost);
router.get('/ingredients', rcp, P('restaurant.ingredients.view'), validate({ query: v.ingListQuery }), c.listIngredients);
router.post('/ingredients', rcp, P('restaurant.ingredients.manage'), validate({ body: v.ingredientCreate }), c.createIngredient);
router.put('/ingredients/:id', rcp, P('restaurant.ingredients.manage'), validate({ ...id, body: v.ingredientUpdate }), c.updateIngredient);
router.get('/ingredients/stock', rcp, P('restaurant.ingredients.view'), validate({ query: v.stockQuery }), c.stock);
router.get('/ingredients/movements', rcp, P('restaurant.ingredients.view'), validate({ query: v.movementQuery }), c.movements);
router.get('/ingredients/expiring', rcp, P('restaurant.ingredients.view'), validate({ query: v.expiringQuery }), c.expiring);
router.get('/ingredients/replenishment', rcp, P('restaurant.ingredients.view'), validate({ query: v.branchQ }), c.replenishment);
router.post('/ingredients/receive', rcp, P('restaurant.ingredients.receive'), validate({ body: v.receiveBody }), requireBranchAccess, idempotent('POST /restaurant/ingredients/receive'), c.receive);
router.get('/ingredients/purchases', rcp, P('restaurant.ingredients.view'), validate({ query: v.purchaseQuery }), c.purchases);
router.post('/ingredients/transfer', rcp, P('restaurant.ingredients.manage'), validate({ body: v.transferBody }), requireBranchAccess, c.transfer);
router.post('/ingredients/waste', rcp, P('restaurant.ingredients.waste'), validate({ body: v.wasteBody }), requireBranchAccess, c.recordWaste);
router.post('/ingredients/adjust', rcp, P('restaurant.ingredients.adjust'), validate({ body: v.adjustBody }), requireBranchAccess, c.adjust);
router.get('/ingredients/counts', rcp, P('restaurant.ingredients.count'), validate({ query: v.countListQuery }), c.listCounts);
router.post('/ingredients/counts', rcp, P('restaurant.ingredients.count'), validate({ body: v.countStart }), requireBranchAccess, c.startCount);
router.get('/ingredients/counts/:id', rcp, P('restaurant.ingredients.count'), validate(id), c.getCount);
router.post('/ingredients/counts/:id/submit', rcp, P('restaurant.ingredients.count'), validate({ ...id, body: v.countSubmit }), c.submitCount);
router.post('/ingredients/counts/:id/approve', rcp, P('restaurant.ingredients.approve'), validate(id), c.approveCount);
router.post('/ingredients/counts/:id/cancel', rcp, P('restaurant.ingredients.count'), validate(id), c.cancelCount);

// ---- orders (waiter)
router.get('/orders', P('restaurant.orders.view'), validate({ query: v.orderListQuery }), c.listOrders);
router.post('/orders', P('restaurant.orders.create'), validate({ body: v.createOrder }), requireBranchAccess, idempotent('POST /restaurant/orders'), c.createOrder);
router.post('/sync', P('restaurant.orders.create'), validate({ body: v.syncBody }), c.syncBatch);
router.get('/orders/:id', P('restaurant.orders.view'), validate(id), c.getOrder);
router.put('/orders/:id', P('restaurant.orders.create'), validate({ ...id, body: v.updateOrderBody }), c.updateOrder);
router.post('/orders/:id/items', P('restaurant.orders.create'), validate({ ...id, body: v.addItemsBody }), idempotent('POST /restaurant/orders/items'), c.addItems);
router.put('/orders/:id/items/:itemId', P('restaurant.orders.create'), validate({ params: v.itemParam, body: v.updateItemBody }), c.updateOrderItem);
router.post('/orders/:id/items/:itemId/cancel', P('restaurant.orders.create'), validate({ params: v.itemParam, body: v.cancelItemBody }), c.cancelItem);
router.post('/orders/:id/send', P('restaurant.orders.create'), validate({ ...id, body: v.versionBody }), c.sendOrder);
router.post('/orders/:id/fire', P('restaurant.orders.create'), validate({ ...id, body: v.fireBody }), c.fireCourse);
router.post('/orders/:id/serve', P('restaurant.orders.create'), validate({ ...id, body: v.serveBody }), c.serve);
router.post('/orders/:id/comp', P('restaurant.orders.comp'), validate({ ...id, body: v.compBody }), c.comp);
router.post('/orders/:id/transfer', P('restaurant.orders.manage'), validate({ ...id, body: v.transferBody2 }), c.transferOrder);
router.post('/orders/:id/reassign', P('restaurant.orders.manage'), validate({ ...id, body: v.reassignBody }), c.reassign);
router.post('/orders/:id/merge', P('restaurant.orders.manage'), validate({ ...id, body: v.mergeBody }), c.mergeOrders);
router.post('/orders/:id/request-bill', P('restaurant.orders.create'), validate(id), c.requestBill);
router.post('/orders/:id/assistance', P('restaurant.orders.create'), validate({ ...id, body: v.assistBody }), c.assistance);
router.post('/orders/:id/cancel', P('restaurant.orders.void'), validate({ ...id, body: v.reasonBody }), c.cancelOrder);
router.post('/orders/:id/reopen', P('restaurant.bills.reopen'), validate({ ...id, body: v.reasonBody }), c.reopenOrder);
router.post('/orders/:id/delivery/assign', P('restaurant.delivery.manage'), validate({ ...id, body: v.riderBody }), c.assignRider);
router.post('/orders/:id/delivery/status', P('restaurant.delivery.self'), validate({ ...id, body: v.deliveryStatusBody }), c.deliveryStatus);
router.post('/orders/:id/pickup/collect', P('restaurant.orders.create'), validate({ ...id, body: v.pickupBody }), c.collectPickup);
router.get('/delivery/mine', P('restaurant.delivery.self'), c.myDeliveries);
router.get('/delivery', P('restaurant.delivery.view'), validate({ query: v.deliveryListQuery }), c.listDeliveries);

// ---- kitchen
router.get('/kitchen/queue', kds, P('restaurant.kitchen.view'), validate({ query: v.kitchenQueue }), requireBranchAccess, c.queue);
router.get('/kitchen/stats', kds, P('restaurant.kitchen.manage'), validate({ query: v.rangeQ }), c.kitchenStats);
router.put('/kitchen/orders/:orderId/items/:itemId', kds, P('restaurant.kitchen.update'), validate({ params: v.kItemParam, body: v.itemStatusBody }), c.kitchenItem);
router.post('/kitchen/tickets/:id/bump', kds, P('restaurant.kitchen.update'), validate({ ...id, body: v.bumpBody }), c.bump);
router.post('/kitchen/tickets/:id/expo', kds, P('restaurant.kitchen.expedite'), validate(id), c.expo);
router.post('/kitchen/tickets/:id/priority', kds, P('restaurant.kitchen.expedite'), validate({ ...id, body: v.priorityBody }), c.priority);
router.get('/print-jobs', c.printJobs);                      // a staff device set to auto-print collects its tickets / receipts
router.post('/print-jobs/:id/done', validate(id), c.printDone);
router.post('/kitchen/tickets/:id/reprint', kds, P('restaurant.kitchen.update'), validate({ ...id, body: v.reasonBody }), c.reprint);

// ---- bills and payments
router.get('/bills', P('restaurant.bills.view'), validate({ query: v.billListQuery }), c.listBills);
router.post('/orders/:id/bills', P('restaurant.bills.generate'), validate({ ...id, body: v.genBill }), c.generateBill);
router.post('/bills/merge', P('restaurant.bills.split'), validate({ body: v.mergeBillsBody }), c.mergeBills);
router.get('/bills/:id', P('restaurant.bills.view'), validate(id), c.getBill);
router.post('/bills/:id/discount', P('restaurant.orders.discount'), validate({ ...id, body: v.discountBody }), c.discount);
router.delete('/bills/:id/discount', P('restaurant.orders.discount'), validate(id), c.removeDiscount);
router.post('/bills/:id/service-charge', P('restaurant.bills.waive_service_charge'), validate({ ...id, body: v.scBody }), c.serviceCharge);
router.post('/bills/:id/split', P('restaurant.bills.split'), validate({ ...id, body: v.splitBody }), c.splitBill);
router.post('/bills/:id/move-items', P('restaurant.bills.split'), validate({ ...id, body: v.moveBody }), c.moveItems);
router.post('/bills/:id/void', P('restaurant.bills.generate'), validate({ ...id, body: v.reasonBody }), c.voidBill);
router.post('/bills/:id/pay', P('restaurant.bills.pay'), validate({ ...id, body: v.payBody }), idempotent('POST /restaurant/bills/pay'), c.pay);
router.post('/bills/:id/close', P('restaurant.bills.pay'), validate({ ...id, body: v.closeBillBody }), idempotent('POST /restaurant/bills/close'), c.closeBill);
router.post('/bills/:id/tips', P('restaurant.bills.pay'), validate({ ...id, body: v.tipBody }), idempotent('POST /restaurant/bills/tips'), c.tip);
router.post('/bills/:id/refund', P('restaurant.bills.refund'), validate({ ...id, body: v.refundBody }), idempotent('POST /restaurant/bills/refund'), c.refund);
router.get('/pay-context', P('restaurant.bills.view'), validate({ query: v.contextQuery }), c.payContext);
router.post('/shift/open', P('restaurant.bills.pay'), validate({ body: v.openShiftBody }), c.openCashShift);
router.get('/payments/unverified', P('restaurant.payments.verify'), validate({ query: v.unverifiedQuery }), c.unverified);
router.post('/bills/:id/payments/:entryId/verify', P('restaurant.payments.verify'), validate({ params: v.entryParam, body: v.verifyBody }), c.verifyPayment);
router.post('/bills/:id/mpesa/stk', P('restaurant.bills.pay'), validate({ ...id, body: v.stkBody }), c.mpesaStk);
router.post('/bills/:id/mpesa/manual', P('restaurant.bills.pay'), validate({ ...id, body: v.manualBody }), c.mpesaManual);
router.get('/mpesa/:reference/status', P('restaurant.bills.pay'), validate({ params: v.refParam }), c.mpesaStatus);
router.post('/mpesa/:reference/claim', P('restaurant.bills.pay'), validate({ params: v.refParam, body: v.claimBody }), c.mpesaClaim);
router.post('/mpesa/:reference/cancel', P('restaurant.bills.pay'), validate({ params: v.refParam }), c.mpesaCancel);

// ---- reservations
router.get('/reservations', rsv, P('restaurant.reservations.view'), validate({ query: v.reservationQuery }), c.listReservations);
router.get('/reservations/availability', rsv, P('restaurant.reservations.view'), validate({ query: v.availQuery }), c.availability);
router.post('/reservations', rsv, P('restaurant.reservations.manage'), validate({ body: v.reservationBody }), requireBranchAccess, c.createReservation);
router.get('/reservations/:id', rsv, P('restaurant.reservations.view'), validate(id), c.getReservation);
router.put('/reservations/:id', rsv, P('restaurant.reservations.manage'), validate({ ...id, body: v.reservationUpdate }), c.updateReservation);
router.post('/reservations/:id/status', rsv, P('restaurant.reservations.manage'), validate({ ...id, body: v.reservationStatus }), c.reservationStatus);
router.post('/reservations/:id/deposit', rsv, P('restaurant.bills.pay'), validate({ ...id, body: v.depositBody }), c.deposit);
router.post('/reservations/:id/deposit/settle', rsv, P('restaurant.reservations.manage'), validate({ ...id, body: v.depositSettle }), c.settleDeposit);

// ---- staff, tips, incidents, waste
router.get('/shifts', P('restaurant.shifts.self'), validate({ query: v.shiftQuery }), c.listShifts);
router.post('/shifts', P('restaurant.shifts.manage'), validate({ body: v.scheduleBody }), requireBranchAccess, c.schedule);
router.post('/duty/start', P('restaurant.shifts.self'), validate({ body: v.clockInBody }), requireBranchAccess, c.clockIn);
router.post('/duty/end', P('restaurant.shifts.self'), validate({ body: v.clockOutBody }), c.clockOut);
router.put('/duty/me', P('restaurant.shifts.self'), validate({ body: v.availabilityBody }), c.availabilityMe);
router.get('/duty', P('restaurant.shifts.view'), validate({ query: v.branchQ }), c.onDuty);
router.post('/handover', P('restaurant.shifts.self'), validate({ body: v.handoverBody }), c.handover);
router.get('/tips', P('restaurant.tips.view'), validate({ query: v.tipQuery }), c.listTips);
router.get('/tips/summary', P('restaurant.tips.manage'), validate({ query: v.rangeQ }), c.tipSummary);
router.post('/tips/allocate', P('restaurant.tips.manage'), validate({ body: v.tipAllocate }), requireBranchAccess, c.allocateTips);
router.post('/tips/payout', P('restaurant.tips.manage'), validate({ body: v.tipPayout }), c.payoutTips);
router.get('/incidents', P('restaurant.incidents.create'), validate({ query: v.incidentQuery }), c.listIncidents);
router.post('/incidents', P('restaurant.incidents.create'), validate({ body: v.incidentBody }), requireBranchAccess, c.createIncident);
router.post('/incidents/:id/resolve', P('restaurant.incidents.manage'), validate({ ...id, body: v.incidentResolve }), c.resolveIncident);
router.get('/waste', P('restaurant.ingredients.view'), validate({ query: v.wasteQuery }), c.listWaste);

// ---- reports
router.get('/reports/dashboard', P('restaurant.reports.view'), validate({ query: v.branchQ }), c.dashboard);
router.get('/reports/summary', P('restaurant.reports.view'), validate({ query: v.rangeQ }), c.repSummary);
router.get('/reports/sales', P('restaurant.reports.view'), validate({ query: v.salesQuery }), c.repSales);
router.get('/reports/food-cost', P('restaurant.reports.view'), validate({ query: v.rangeQ }), c.repFoodCost);
router.get('/reports/staff', P('restaurant.reports.staff'), validate({ query: v.rangeQ }), c.repStaff);
router.get('/reports/waste', P('restaurant.reports.view'), validate({ query: v.rangeQ }), c.repWaste);
router.get('/reports/stock-variance', P('restaurant.reports.view'), validate({ query: v.rangeQ }), c.repVariance);
router.get('/reports/reconciliation', P('restaurant.reports.view'), validate({ query: v.rangeQ }), c.repReconciliation);
router.get('/reports/delivery', P('restaurant.reports.view'), validate({ query: v.rangeQ }), c.repDelivery);

// ---- guest QR ordering (staff side): orders waiting for acceptance, "call waiter" requests, QR codes
const gq = require('../middleware/requireFeature')('guestQrOrdering'); const hv = require('../validators/hospitality.validator'); const hc = require('../controllers/hospitality.controller');
router.get('/guest/requests', gq, P('restaurant.guest.view'), validate({ query: hv.requestQuery }), hc.listRequests);
router.post('/guest/requests/:id/accept', gq, P('restaurant.guest.respond'), validate({ params: hv.idParam, body: hv.acceptBody }), hc.acceptRequest);
router.post('/guest/requests/:id/reject', gq, P('restaurant.guest.respond'), validate({ params: hv.idParam, body: hv.rejectBody }), hc.rejectRequest);
router.get('/guest/calls', gq, P('restaurant.guest.view'), validate({ query: hv.callQuery }), hc.listCalls);
router.post('/guest/calls', gq, P('restaurant.guest.respond'), validate({ body: hv.callCreate }), hc.createCall);
router.post('/guest/calls/:id/acknowledge', gq, P('restaurant.guest.respond'), validate({ params: hv.idParam }), hc.ackCall);
router.post('/guest/calls/:id/resolve', gq, P('restaurant.guest.respond'), validate({ params: hv.idParam }), hc.resolveCall);
router.get('/qr', gq, P('restaurant.guest.qr'), validate({ query: hv.qrQuery }), hc.listQr);
router.post('/qr/:kind/:id/rotate', gq, P('restaurant.guest.qr'), validate({ params: hv.qrParam }), hc.rotateQr);
router.post('/qr/:kind/:id/enabled', gq, P('restaurant.guest.qr'), validate({ params: hv.qrParam, body: hv.qrEnable }), hc.enableQr);
router.post('/orders/:id/claim', P('restaurant.orders.create'), validate({ params: hv.idParam }), hc.claimOrder);

module.exports = router;
