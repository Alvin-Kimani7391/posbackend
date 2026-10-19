const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const R = require('../constants/restaurant');
const H = require('../constants/hospitality');
const { UNIT_NAMES } = require('../utils/restaurantUnits');

const money = z.coerce.number().positive().transform(toCents);
const money0 = z.coerce.number().min(0).transform(toCents);
const moneyAny = z.coerce.number().transform(toCents);
const idParam = z.object({ id: objectId });
const itemParam = z.object({ id: objectId, itemId: objectId });
const str = (n = 200) => z.string().trim().max(n);
const reason = z.string().trim().min(3, 'Give a reason').max(300);
const optReason = z.string().trim().max(300).optional();
const date = z.coerce.date();
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/);
const windowSchema = z.object({ days: z.array(z.number().int().min(0).max(6)).optional(), start: hhmm.optional(), end: hhmm.optional(), startDate: date.optional(), endDate: date.optional() });
const branchQ = z.object({ branchId: objectId.optional() });
const rangeQ = z.object({ branchId: objectId.optional(), from: date.optional(), to: date.optional() });
// The ingredient, stock and menu screens load up to 200 rows at once (the shared pagination schema stops at 100, which made them fail with 400).
const pageQ = paginationQuery.extend({ limit: z.coerce.number().int().min(1).max(200).default(20) });

// ---- settings / floor
const settingsSchema = z.object({
  serviceCharge: z.object({ enabled: z.boolean(), percent: z.coerce.number().min(0).max(100), taxRate: z.coerce.number().min(0).max(100), orderTypes: z.array(z.enum(R.ORDER_TYPES)) }).partial().optional(),
  tips: z.object({ enabled: z.boolean(), mode: z.enum(['INDIVIDUAL', 'POOL']), poolRoles: z.array(z.string()) }).partial().optional(),
  stockDepletionEvent: z.enum(R.STOCK_DEPLETION_EVENTS).optional(), stockLocations: z.enum(['SINGLE', 'MULTI']).optional(),
  allowNegativeIngredients: z.boolean().optional(), hideOutOfStockItems: z.boolean().optional(), kitchenDelayMinutes: z.coerce.number().int().min(1).max(240).optional(),
  discounts: z.object({ waiterMaxPercent: z.coerce.number().min(0).max(100), cashierMaxPercent: z.coerce.number().min(0).max(100), supervisorMaxPercent: z.coerce.number().min(0).max(100), managerMaxPercent: z.coerce.number().min(0).max(100) }).partial().optional(),
  serviceMode: z.enum(H.SERVICE_MODES).optional(),
  guestOrdering: z.object({
    tableMode: z.enum(H.GUEST_MODES), roomMode: z.enum(H.GUEST_MODES), maxAutoOrderCents: money0, selfSeat: z.boolean(), requireName: z.boolean(), requirePhone: z.boolean(),
    maxItemsPerRequest: z.coerce.number().int().min(1).max(100), maxQuantityPerItem: z.coerce.number().int().min(1).max(200), allowNotes: z.boolean(), showPrices: z.boolean(), allowBillRequest: z.boolean(),
    callCooldownSeconds: z.coerce.number().int().min(0).max(3600), requestExpiryMinutes: z.coerce.number().int().min(2).max(240),
    baseUrl: z.string().trim().url().max(200).or(z.literal('')), welcomeMessage: str(300), welcomeMessageSw: str(300),
  }).partial().optional(),
  requireTableCleaning: z.boolean().optional(), paymentsRequireShift: z.boolean().optional(),
  reservation: z.object({ durationMinutes: z.coerce.number().int().min(15).max(600), holdMinutes: z.coerce.number().int().min(0).max(120), depositRequired: z.boolean(), depositCents: money0, remindMinutes: z.coerce.number().int().min(0).max(1440) }).partial().optional(),
}).strict();
const areaBody = z.object({ branchId: objectId, name: str(60).min(1), type: z.enum(R.AREA_TYPES).optional(), sortOrder: z.coerce.number().int().optional() });
const areaUpdate = areaBody.omit({ branchId: true }).partial();
const stationBody = z.object({ branchId: objectId, name: str(60).min(1), code: str(20).min(2), type: z.enum(['KITCHEN', 'BAR']).optional(), isDefault: z.boolean().optional(), printerName: str(80).optional() });
const stationUpdate = stationBody.omit({ branchId: true }).partial();
const tableBody = z.object({ branchId: objectId, areaId: objectId.optional(), name: str(30).min(1), seats: z.coerce.number().int().min(1).max(100).optional(), position: z.object({ x: z.number(), y: z.number(), shape: str(20).optional() }).optional() });
const tableUpdate = tableBody.omit({ branchId: true }).partial().extend({ active: z.boolean().optional() });
const tableStatus = z.object({ status: z.enum(R.TABLE_STATUS), reason: optReason });
const assignBody = z.object({ waiterId: objectId.nullable().optional() });
const combineBody = z.object({ primaryId: objectId, tableIds: z.array(objectId).min(1).max(20) });
const floorQuery = z.object({ branchId: objectId, areaId: objectId.optional() });

// ---- menu
const optionBody = z.object({ name: str(80).min(1), priceDelta: moneyAny.optional(), costDelta: moneyAny.optional(), allergens: z.array(z.enum(R.ALLERGENS)).optional(), substitution: z.boolean().optional(), removal: z.boolean().optional(), ingredientLines: z.array(z.object({ ingredientId: objectId, quantity: z.coerce.number() })).optional(), soldOut: z.boolean().optional(), active: z.boolean().optional(), sortOrder: z.number().optional() });
const groupBody = z.object({ name: str(80).min(1), required: z.boolean().optional(), min: z.coerce.number().int().min(0).optional(), max: z.coerce.number().int().min(0).optional(), allowQuantity: z.boolean().optional(), options: z.array(optionBody).max(60).optional(), active: z.boolean().optional() });
const itemBase = {
  categoryId: objectId.optional(), name: str(120).min(1), description: str(500).optional(), image: str(500).optional(), basePrice: money0,
  typePrices: z.object({ dineIn: money0.optional(), takeaway: money0.optional(), delivery: money0.optional() }).optional(),
  branchOverrides: z.array(z.object({ branchId: objectId, price: money0.optional(), available: z.boolean().optional() })).optional(),
  variants: z.array(z.object({ name: str(60).min(1), price: money0.optional(), priceDelta: moneyAny.optional(), portionMultiplier: z.coerce.number().min(0.01).optional(), active: z.boolean().optional() })).optional(), requireVariant: z.boolean().optional(),
  modifierGroupIds: z.array(objectId).optional(),
  timedPrices: z.array(z.object({ label: str(60).optional(), windows: z.array(windowSchema).min(1), price: money0.optional(), percentOff: z.coerce.number().min(0).max(100).optional(), branchIds: z.array(objectId).optional() }).refine((t) => t.price !== undefined || t.percentOff !== undefined, 'Give a price or a percent off')).optional(),
  menuPeriods: z.array(windowSchema).optional(), taxRate: z.coerce.number().min(0).max(100).optional(), serviceChargeable: z.boolean().optional(), prepMinutes: z.coerce.number().int().min(0).max(600).optional(),
  stationCode: str(20).optional(), allergens: z.array(z.enum(R.ALLERGENS)).optional(), stockMode: z.enum(R.STOCK_MODES).optional(), productId: objectId.optional(),
  isCombo: z.boolean().optional(), comboGroups: z.array(z.object({ name: str(60).min(1), min: z.coerce.number().int().min(0).optional(), max: z.coerce.number().int().min(0).optional(), options: z.array(z.object({ menuItemId: objectId, priceDelta: moneyAny.optional() })).min(1) })).optional(), sortOrder: z.coerce.number().optional(),
};
const itemCreate = z.object(itemBase);
const itemUpdate = z.object(itemBase).partial();
const soldOutBody = z.object({ soldOut: z.boolean(), reason: optReason });
const itemListQuery = pageQ.extend({ categoryId: objectId.optional(), status: z.enum(['active', 'archived']).optional() });
const menuQuery = z.object({ branchId: objectId, orderType: z.enum(R.ORDER_TYPES).optional() });

// ---- recipes / ingredients
const recipeBody = z.object({ menuItemId: objectId, yieldPortions: z.coerce.number().positive().optional(), changeNote: str(300).optional(), lines: z.array(z.object({ ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), prepLossPercent: z.coerce.number().min(0).max(95).optional(), optional: z.boolean().optional() })).min(1).max(60) });
const recipeQuery = z.object({ menuItemId: objectId });
const costQuery = z.object({ variantId: objectId.optional() });
const ingCost = z.object({ amountCents: money0, per: z.enum(UNIT_NAMES).optional() });
const ingredientBody = z.object({ name: str(120).min(1), sku: str(40).optional(), baseUnit: z.enum(['g', 'ml', 'piece']), purchaseUnit: z.enum(UNIT_NAMES).optional(), cost: ingCost.optional(), lowStockLevel: z.coerce.number().min(0).optional(), reorderLevel: z.coerce.number().min(0).optional(), parLevel: z.coerce.number().min(0).optional(), trackBatch: z.boolean().optional(), shelfLifeDays: z.coerce.number().int().min(0).optional(), supplierId: objectId.optional(), allergens: z.array(z.enum(R.ALLERGENS)).optional() });
const ingredientCreate = ingredientBody;
const ingredientUpdate = ingredientBody.partial().extend({ status: z.enum(['active', 'archived']).optional() });
const ingListQuery = pageQ.extend({ status: z.enum(['active', 'archived']).optional() });
const loc = z.enum(R.INGREDIENT_LOCATIONS);
const receiveBody = z.object({ branchId: objectId, supplierId: objectId.optional(), invoiceNumber: str(60).optional(), amountPaid: money0.optional(), notes: str(300).optional(), lines: z.array(z.object({ ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), unitCostCents: money0, batchNumber: str(60).optional(), expiryDate: date.optional(), location: loc.optional() })).min(1).max(100) });
const transferBody = z.object({ branchId: objectId, ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), from: loc, to: loc, reason: optReason });
const wasteBody = z.object({ branchId: objectId, ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), kind: z.enum(['WASTE', 'SPOILAGE', 'EXPIRED', 'STAFF_MEAL', 'COMPLIMENTARY', 'REMAKE']), reason: reason.optional(), location: loc.optional() });
const adjustBody = z.object({ branchId: objectId, ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), direction: z.enum(['IN', 'OUT']), reason, location: loc.optional() });
const countStart = z.object({ branchId: objectId, location: loc.optional() });
const countSubmit = z.object({ notes: str(300).optional(), lines: z.array(z.object({ ingredientId: objectId, countedQuantity: z.coerce.number().min(0), unit: z.enum(UNIT_NAMES).optional(), reason: optReason })).min(1) });
const stockQuery = pageQ.extend({ branchId: objectId.optional(), location: loc.optional(), lowOnly: z.coerce.boolean().optional() });
const movementQuery = pageQ.extend({ branchId: objectId.optional(), ingredientId: objectId.optional(), type: z.enum(R.INGREDIENT_MOVEMENT_TYPES).optional(), from: date.optional(), to: date.optional() });
const purchaseQuery = pageQ.extend({ branchId: objectId.optional(), supplierId: objectId.optional(), from: date.optional(), to: date.optional() });
const countListQuery = pageQ.extend({ branchId: objectId.optional(), status: z.enum(['OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED']).optional() });
const expiringQuery = z.object({ branchId: objectId.optional(), days: z.coerce.number().int().min(1).max(90).optional() });

// ---- orders
const modSel = z.object({ groupId: objectId, optionId: objectId, quantity: z.coerce.number().int().min(1).max(20).optional() });
const itemInput = z.object({ menuItemId: objectId, quantity: z.coerce.number().positive().max(999), variantId: objectId.optional(), modifiers: z.array(modSel).max(40).optional(), comboPicks: z.array(z.object({ groupId: objectId, menuItemId: objectId, quantity: z.coerce.number().int().min(1).optional(), variantId: objectId.optional() })).optional(), notes: str(300).optional(), allergyNotes: str(300).optional(), course: z.coerce.number().int().min(1).max(9).optional(), seatNumber: z.coerce.number().int().min(1).max(100).optional(), clientItemId: str(80).optional() });
const deliveryInput = z.object({ contactName: str(120).optional(), phone: str(20).optional(), address: str(300).optional(), landmark: str(120).optional(), instructions: str(300).optional(), fee: money0.optional(), platform: str(60).optional(), commissionPercent: z.coerce.number().min(0).max(100).optional() });
const createOrder = z.object({ roomId: objectId.optional(), stayId: objectId.optional(), branchId: objectId, orderType: z.enum(R.ORDER_TYPES).optional(), source: z.enum(R.ORDER_SOURCES).optional(), tableId: objectId.optional(), guestCount: z.coerce.number().int().min(0).max(500).optional(), customerId: objectId.optional(), customerName: str(120).optional(), customerPhone: str(20).optional(), waiterId: objectId.optional(), reservationId: objectId.optional(), notes: str(500).optional(), priority: z.enum(R.TICKET_PRIORITY).optional(), delivery: deliveryInput.optional(), clientRef: str(80).optional(), deviceId: str(80).optional() });
const addItemsBody = z.object({ items: z.array(itemInput).min(1).max(60), sendNow: z.boolean().optional(), expectedVersion: z.coerce.number().int().optional() });
const updateItemBody = z.object({ quantity: z.coerce.number().positive().optional(), notes: str(300).optional(), allergyNotes: str(300).optional(), seatNumber: z.coerce.number().int().min(1).optional(), course: z.coerce.number().int().min(1).max(9).optional(), expectedVersion: z.coerce.number().int().optional() });
const cancelItemBody = z.object({ reason: str(300).optional(), quantity: z.coerce.number().positive().optional(), expectedVersion: z.coerce.number().int().optional() });
const versionBody = z.object({ expectedVersion: z.coerce.number().int().optional() });
const fireBody = z.object({ course: z.coerce.number().int().min(2).max(9) });
const serveBody = z.object({ itemIds: z.array(objectId).optional(), allReady: z.boolean().optional() }).refine((b) => b.allReady || b.itemIds?.length, 'Choose items or allReady');
const compBody = z.object({ itemIds: z.array(objectId).min(1), reason, kind: z.enum(['COMPLIMENTARY', 'STAFF_MEAL']).optional(), remove: z.boolean().optional() });
const updateOrderBody = z.object({ guestCount: z.coerce.number().int().min(0).optional(), customerId: objectId.nullable().optional(), customerName: str(120).optional(), customerPhone: str(20).optional(), notes: str(500).optional(), priority: z.enum(R.TICKET_PRIORITY).optional(), expectedVersion: z.coerce.number().int().optional() });
const transferBody2 = z.object({ toTableId: objectId, expectedVersion: z.coerce.number().int().optional() });
const reassignBody = z.object({ waiterId: objectId, note: optReason });
const mergeBody = z.object({ sourceOrderId: objectId });
const assistBody = z.object({ reason, type: z.enum(['ASSISTANCE', 'COMPLAINT', 'DELAY', 'ALLERGY']).optional() });
const reasonBody = z.object({ reason });
const riderBody = z.object({ riderId: objectId });
const deliveryStatusBody = z.object({ status: z.enum(['ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED']), reason: optReason });
const pickupBody = z.object({ collectedBy: str(120).min(1) });
const orderListQuery = pageQ.extend({ branchId: objectId.optional(), status: z.enum(R.ORDER_STATUS).optional(), orderType: z.enum(R.ORDER_TYPES).optional(), tableId: objectId.optional(), waiterId: objectId.optional(), billStatus: z.enum(R.ORDER_BILL_STATUS).optional(), from: date.optional(), to: date.optional(), mine: z.coerce.boolean().optional() });
const syncBody = z.object({ ops: z.array(z.object({ clientOpId: str(80), type: z.enum(['createOrder', 'addItems', 'send', 'serve', 'cancelItem']), orderRef: z.object({ orderId: objectId.optional(), clientRef: str(80).optional(), deviceId: str(80).optional() }).optional(), itemId: objectId.optional(), payload: z.any().optional() })).min(1).max(200) });

// ---- kitchen
const kitchenQueue = z.object({ branchId: objectId, stationId: objectId.optional(), status: z.enum(R.TICKET_STATUS).optional(), includeCompleted: z.coerce.boolean().optional(), sinceMinutes: z.coerce.number().int().min(1).max(1440).optional() });
const itemStatusBody = z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'SERVED']) });
const bumpBody = z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY']).optional() });
const priorityBody = z.object({ priority: z.enum(R.TICKET_PRIORITY) });
const kItemParam = z.object({ orderId: objectId, itemId: objectId });

// ---- bills
const genBill = z.object({ label: str(60).optional(), customerId: objectId.optional() });
const discountBody = z.object({ type: z.enum(['PERCENT', 'AMOUNT']), value: z.coerce.number().positive(), reason }).transform((b) => ({ ...b, value: b.type === 'AMOUNT' ? toCents(b.value) : b.value })).refine((b) => b.type !== 'PERCENT' || b.value <= 100, 'Percent cannot exceed 100');
const scBody = z.object({ waive: z.boolean(), reason: optReason });
const splitBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('EQUAL'), ways: z.coerce.number().int().min(2).max(20) }),
  z.object({ mode: z.literal('ITEMS'), selections: z.array(z.object({ orderItemId: objectId, quantity: z.coerce.number().positive() })).min(1), label: str(60).optional() }),
  z.object({ mode: z.literal('AMOUNT'), amount: money, label: str(60).optional() }),
  z.object({ mode: z.literal('SEAT') }),
]);
const moveBody = z.object({ toBillId: objectId, selections: z.array(z.object({ orderItemId: objectId, quantity: z.coerce.number().positive() })).min(1) });
const mergeBillsBody = z.object({ billIds: z.array(objectId).min(2).max(10) });
const payBody = z.object({ customerId: objectId.optional(), payments: z.array(z.object({ method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'CREDIT', 'DEPOSIT', 'ROOM', 'OTHER']), amount: money, tendered: money.optional(), reference: str(100).optional(), network: str(40).optional(), payerPhone: str(20).optional(), reservationId: objectId.optional(), stayId: objectId.optional() })).min(1).max(10) });
const tipBody = z.object({ amount: money, method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']), reference: str(100).optional(), waiterId: objectId.optional() });
const closeBillBody = z.object({ reason: optReason });
const refundBody = z.object({ amount: money, method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']), reason });
const billListQuery = pageQ.extend({ branchId: objectId.optional(), status: z.enum(R.BILL_STATUS).optional(), orderId: objectId.optional(), mine: z.coerce.boolean().optional() });
const stkBody = z.object({ phone: z.string().trim().min(9), amountCents: money.optional(), customerName: str(120).optional() });
const manualBody = z.object({ amountCents: money.optional() });
const claimBody = z.object({ receiptCode: z.string().trim().refine((v) => /^[A-Za-z][A-Za-z0-9]{9}$/.test(v), 'Enter the 10-character M-PESA code') });
const refParam = z.object({ reference: z.string().trim().min(3) });
const verifyBody = z.object({ approve: z.boolean(), note: str(300).optional() });
const entryParam = z.object({ id: objectId, entryId: objectId });
const unverifiedQuery = z.object({ branchId: objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const contextQuery = z.object({ branchId: objectId });
const openShiftBody = z.object({ branchId: objectId, registerId: objectId, openingCash: money0 });

// ---- reservations / staff
const reservationBody = z.object({ branchId: objectId, guestName: str(120).min(2), phone: str(20).min(7), customerId: objectId.optional(), partySize: z.coerce.number().int().min(1).max(500), startsAt: date.optional(), durationMinutes: z.coerce.number().int().min(15).max(600).optional(), tableIds: z.array(objectId).optional(), source: z.enum(['PHONE', 'WALK_IN', 'ONLINE', 'STAFF']).optional(), occasion: str(80).optional(), notes: str(500).optional(), waitlist: z.boolean().optional(), quotedWaitMinutes: z.coerce.number().int().min(0).optional(), depositAmount: money0.optional(), overrideCapacity: z.boolean().optional() });
const reservationUpdate = reservationBody.omit({ branchId: true, waitlist: true, source: true, customerId: true, depositAmount: true }).partial();
const reservationStatus = z.object({ status: z.enum(['CONFIRMED', 'ARRIVED', 'CANCELLED', 'NO_SHOW']), reason: optReason });
const depositBody = z.object({ method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']), amount: money, reference: str(100).optional() });
const depositSettle = z.object({ action: z.enum(['REFUND', 'FORFEIT']), method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']).optional(), reason: optReason });
const reservationQuery = pageQ.extend({ branchId: objectId.optional(), status: z.enum(R.RESERVATION_STATUS).optional(), from: date.optional(), to: date.optional() });
const availQuery = z.object({ branchId: objectId, startsAt: date, durationMinutes: z.coerce.number().int().min(15).max(600).optional(), partySize: z.coerce.number().int().min(1).optional() });
const scheduleBody = z.object({ userId: objectId, branchId: objectId, scheduledStart: date, scheduledEnd: date, role: str(30).optional(), notes: str(300).optional() });
const clockInBody = z.object({ branchId: objectId, acceptingTables: z.boolean().optional() });
const clockOutBody = z.object({ force: z.boolean().optional() });
const availabilityBody = z.object({ status: z.enum(['ON_DUTY', 'BREAK', 'UNAVAILABLE']).optional(), acceptingTables: z.boolean().optional() });
const handoverBody = z.object({ toUserId: objectId, fromUserId: objectId.optional(), orderIds: z.array(objectId).optional(), note: optReason });
const shiftQuery = pageQ.extend({ branchId: objectId.optional(), userId: objectId.optional(), status: z.enum(['SCHEDULED', 'ON_DUTY', 'BREAK', 'UNAVAILABLE', 'COMPLETED', 'ABSENT']).optional(), from: date.optional(), to: date.optional() });
const tipQuery = pageQ.extend({ branchId: objectId.optional(), waiterId: objectId.optional(), status: z.enum(['RECORDED', 'ALLOCATED', 'PAID_OUT']).optional(), from: date.optional(), to: date.optional() });
const tipAllocate = z.object({ branchId: objectId, from: date, to: date });
const tipPayout = z.object({ tipIds: z.array(objectId).min(1) });
const incidentBody = z.object({ branchId: objectId, type: z.enum(R.INCIDENT_TYPES), orderId: objectId.optional(), orderItemId: objectId.optional(), description: str(1000).min(3), severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional() });
const incidentResolve = z.object({ resolution: str(500).min(3), compensation: str(300).optional() });
const incidentQuery = pageQ.extend({ branchId: objectId.optional(), status: z.enum(['OPEN', 'RESOLVED']).optional(), type: z.enum(R.INCIDENT_TYPES).optional() });
const wasteQuery = pageQ.extend({ branchId: objectId.optional(), kind: z.enum(R.WASTE_KINDS).optional(), from: date.optional(), to: date.optional() });
const salesQuery = z.object({ branchId: objectId.optional(), from: date.optional(), to: date.optional(), groupBy: z.enum(['day', 'hour', 'dow', 'item', 'category', 'waiter', 'orderType', 'table', 'branch']).optional() });
const deliveryListQuery = z.object({ branchId: objectId.optional(), status: z.enum(R.DELIVERY_STATUS).optional() });

module.exports = {
  idParam, itemParam, branchQ, rangeQ, settingsSchema, areaBody, areaUpdate, stationBody, stationUpdate, tableBody, tableUpdate, tableStatus, assignBody, combineBody, floorQuery,
  groupBody, itemCreate, itemUpdate, soldOutBody, itemListQuery, menuQuery, recipeBody, recipeQuery, costQuery, ingredientCreate, ingredientUpdate, ingListQuery, receiveBody, transferBody, wasteBody, adjustBody,
  countStart, countSubmit, stockQuery, movementQuery, purchaseQuery, countListQuery, expiringQuery, createOrder, addItemsBody, updateItemBody, cancelItemBody, versionBody, fireBody, serveBody, compBody,
  updateOrderBody, transferBody2, reassignBody, mergeBody, assistBody, reasonBody, riderBody, deliveryStatusBody, pickupBody, orderListQuery, syncBody, kitchenQueue, itemStatusBody, bumpBody, priorityBody, kItemParam,
  genBill, discountBody, scBody, splitBody, moveBody, mergeBillsBody, payBody, tipBody, closeBillBody, refundBody, billListQuery, stkBody, manualBody, claimBody, refParam, verifyBody, entryParam, unverifiedQuery, contextQuery, openShiftBody,
  reservationBody, reservationUpdate, reservationStatus, depositBody, depositSettle, reservationQuery, availQuery, scheduleBody, clockInBody, clockOutBody, availabilityBody, handoverBody, shiftQuery,
  tipQuery, tipAllocate, tipPayout, incidentBody, incidentResolve, incidentQuery, wasteQuery, salesQuery, deliveryListQuery, pageQ,
};
