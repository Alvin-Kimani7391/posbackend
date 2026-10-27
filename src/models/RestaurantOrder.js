const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');

const modifierSnap = new Schema({
  groupId: Schema.Types.ObjectId, optionId: Schema.Types.ObjectId, groupName: String, name: String, quantity: { type: Number, default: 1 },
  priceDelta: { type: Number, default: 0 }, costDelta: { type: Number, default: 0 }, allergens: [String], substitution: Boolean, removal: Boolean,
  ingredientLines: [{ _id: false, ingredientId: Schema.Types.ObjectId, quantity: Number }],
}, { _id: false });

const itemSchema = new Schema({
  clientItemId: { type: String },                                  // offline dedup: the same id is never added twice
  menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem' },    // null for system lines (delivery fee)
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  sku: { type: String, required: true },
  name: { type: String, required: true },
  variantId: Schema.Types.ObjectId, variantName: String, portionMultiplier: { type: Number, default: 1 },
  categoryId: Schema.Types.ObjectId, categoryName: String,
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true },                     // integer cents, includes variant, promotion and modifiers
  basePrice: { type: Number, default: 0 }, promoLabel: String,
  taxRate: { type: Number, default: 0 }, serviceChargeable: { type: Boolean, default: true },
  costUnit: { type: Number, default: 0 },                          // cents per portion snapshot (recipe cost in force when added)
  modifiers: { type: [modifierSnap], default: [] },
  notes: { type: String, trim: true }, allergyNotes: { type: String, trim: true }, allergens: [String],
  course: { type: Number, default: 1, min: 1, max: 9 }, seatNumber: { type: Number, min: 1 },
  stationId: Schema.Types.ObjectId, stationCode: String, stationName: String, stationType: { type: String, default: 'KITCHEN' },
  prepMinutes: { type: Number, default: 0 },
  status: { type: String, enum: C.ITEM_STATUS, default: 'DRAFT' },
  discount: { type: Number, default: 0 },
  isComplimentary: { type: Boolean, default: false }, compReason: String, compKind: { type: String, enum: ['COMPLIMENTARY', 'STAFF_MEAL'] }, compBy: Schema.Types.ObjectId,
  parentItemId: Schema.Types.ObjectId, comboGroup: String,
  stockMode: { type: String, enum: C.STOCK_MODES, default: 'NONE' },
  recipeId: Schema.Types.ObjectId, recipeVersion: Number,
  stockState: { type: String, enum: C.ITEM_STOCK_STATE, default: 'NONE' },
  stockLines: [{ _id: false, ingredientId: Schema.Types.ObjectId, location: String, quantity: Number, unitCost: Number, batches: [{ _id: false, batchId: Schema.Types.ObjectId, quantity: Number }] }],
  ticketId: Schema.Types.ObjectId,
  addedBy: Schema.Types.ObjectId, addedAt: { type: Date, default: Date.now },
  sentAt: Date, acceptedAt: Date, preparingAt: Date, readyAt: Date, servedAt: Date,
  cancelledAt: Date, cancelledBy: Schema.Types.ObjectId, cancelReason: String, cancelledAfterPrep: Boolean,
});

const historySchema = new Schema({ at: { type: Date, default: Date.now }, action: String, by: Schema.Types.ObjectId, note: String, data: Schema.Types.Mixed }, { _id: false });

const orderSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  orderNumber: { type: String, required: true },
  pickupNumber: String,
  orderType: { type: String, enum: C.ORDER_TYPES, default: 'DINE_IN' },
  source: { type: String, enum: C.ORDER_SOURCES, default: 'WAITER' },
  tableId: { type: Schema.Types.ObjectId, ref: 'RestaurantTable' },
  tableName: String,
  waiterId: { type: Schema.Types.ObjectId, ref: 'User' },
  waiterName: String,
  openedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  guestCount: { type: Number, default: 1, min: 0 },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  customerName: String, customerPhone: String,
  reservationId: { type: Schema.Types.ObjectId, ref: 'Reservation' },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room' }, roomNumber: String, stayId: { type: Schema.Types.ObjectId, ref: 'Stay' },   // ROOM_SERVICE orders
  guestRequestIds: [{ type: Schema.Types.ObjectId, ref: 'GuestRequest' }],                                                   // QR orders merged into this order
  items: { type: [itemSchema], default: [] },
  notes: String,
  priority: { type: String, enum: C.TICKET_PRIORITY, default: 'NORMAL' },
  status: { type: String, enum: C.ORDER_STATUS, default: 'OPEN' },
  billStatus: { type: String, enum: C.ORDER_BILL_STATUS, default: 'NONE' },
  billRequestedAt: Date,
  assistance: { at: Date, by: Schema.Types.ObjectId, reason: String },
  totals: { itemsTotal: { type: Number, default: 0 }, serviceCharge: { type: Number, default: 0 }, tax: { type: Number, default: 0 }, total: { type: Number, default: 0 }, discount: { type: Number, default: 0 } },
  delivery: {
    contactName: String, phone: String, address: String, landmark: String, instructions: String, fee: { type: Number, default: 0 },
    lat: Number, lng: Number, distanceKm: Number, etaMinutes: Number, mapsUrl: String, locationMethod: { type: String, enum: ['PIN', 'ZONE'] }, feeMode: String, county: String, town: String, payment: { type: String, default: 'CASH' }, trackKey: { type: String, index: true }, online: { type: Boolean, default: false },
    riderId: Schema.Types.ObjectId, riderName: String, riderPhone: String, status: { type: String, enum: C.DELIVERY_STATUS }, assignedAt: Date, outForDeliveryAt: Date, deliveredAt: Date, failReason: String,
    // ---- rider app + live tracking (services/delivery) ----
    pickedUpAt: Date, arrivedAt: Date, arrivedFarM: Number,                       // arrivedFarM: how far from the pin the rider was when he pressed "Arrived" (null = close enough)
    customerLive: { lat: Number, lng: Number, at: Date },                         // the customer moved their pin / shared their live spot
    tracking: { distanceM: Number, etaMinutes: Number, lat: Number, lng: Number, speed: Number, heading: Number, at: Date, minDistanceM: Number, alertsSent: [Number], nearNotified: Boolean },
    alerts: { type: [new Schema({ id: String, kind: String, distanceM: Number, message: String, at: { type: Date, default: Date.now } }, { _id: false })], default: undefined },
    rating: { stars: { type: Number, min: 1, max: 5 }, comment: String, at: Date },
    platform: String, commissionPercent: { type: Number, default: 0 },
  },
  // Self-service kiosk orders only (source KIOSK). paymentState gates the kitchen: items stay HELD until it is PAID.
  selfService: {
    publicCode: { type: String },                                  // unguessable handle the customer's screen uses; never the order id
    paymentMethod: { type: String, enum: ['MPESA', 'CASH'] },
    paymentState: { type: String, enum: ['PENDING', 'AWAITING_CASH', 'PAID', 'EXPIRED'] },
    expiresAt: Date, paidAt: Date, releasedAt: Date,
    confirmedBy: Schema.Types.ObjectId, confirmedByName: String,   // the cashier who took the cash
    billPrints: { type: Number, default: 0 },
  },
  pickup: { status: { type: String, enum: ['WAITING', 'COLLECTED'] }, collectedAt: Date, collectedBy: String },
  version: { type: Number, default: 1 },                           // optimistic concurrency: mutating calls may send expectedVersion
  clientRef: String, deviceId: String,                            // offline create dedup
  firstSentAt: Date, closedAt: Date, cancelledAt: Date, cancelledBy: Schema.Types.ObjectId, cancelReason: String,
  history: { type: [historySchema], default: [] },
}, { timestamps: true });

orderSchema.index({ businessId: 1, branchId: 1, orderNumber: 1 }, { unique: true });
orderSchema.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, waiterId: 1, status: 1 });
orderSchema.index({ businessId: 1, createdAt: -1 });
orderSchema.index({ businessId: 1, stayId: 1, status: 1 }, { sparse: true });
// HARD guarantee: one open dine-in order per table, even if two waiters tap "open table" at the same instant.
orderSchema.index({ businessId: 1, tableId: 1 }, { unique: true, partialFilterExpression: { status: 'OPEN', orderType: 'DINE_IN', tableId: { $type: 'objectId' } } });
orderSchema.index({ businessId: 1, branchId: 1, deviceId: 1, clientRef: 1 }, { unique: true, partialFilterExpression: { deviceId: { $type: 'string' }, clientRef: { $type: 'string' } } });

orderSchema.index({ businessId: 1, 'selfService.publicCode': 1 }, { unique: true, partialFilterExpression: { 'selfService.publicCode': { $type: 'string' } } });
orderSchema.index({ source: 1, 'selfService.paymentState': 1, 'selfService.expiresAt': 1 }, { partialFilterExpression: { source: 'KIOSK' } });

// Live TV order-status boards refresh the moment any order changes (debounced; a no-op when no TV is connected).
orderSchema.post('save', (doc) => { try { require('../services/tv/tv.service').ordersChanged(doc.businessId, doc.branchId); } catch (e) { /* never break an order write */ } });

moneyPaths(orderSchema, ['totals.itemsTotal', 'totals.serviceCharge', 'totals.tax', 'totals.total', 'totals.discount', 'delivery.fee', 'items.unitPrice', 'items.basePrice', 'items.costUnit', 'items.discount', 'items.modifiers.priceDelta', 'items.modifiers.costDelta']);

module.exports = model('RestaurantOrder', orderSchema);
