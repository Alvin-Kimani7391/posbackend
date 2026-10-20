const { Schema, model } = require('mongoose');
const { ORDER_TYPES, STOCK_DEPLETION_EVENTS } = require('../constants/restaurant');
const { SERVICE_MODES, GUEST_MODES } = require('../constants/hospitality');

/** One document per business. Everything the owner configures for the restaurant module lives here. */
const restaurantSettingsSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  serviceCharge: {
    enabled: { type: Boolean, default: false },
    percent: { type: Number, default: 10, min: 0, max: 100 },
    taxRate: { type: Number, default: 0, min: 0, max: 100 },
    orderTypes: { type: [{ type: String, enum: ORDER_TYPES }], default: ['DINE_IN'] },
  },
  tips: {
    enabled: { type: Boolean, default: true },
    mode: { type: String, enum: ['INDIVIDUAL', 'POOL'], default: 'INDIVIDUAL' }, // INDIVIDUAL = to the waiter on the order; POOL = shared among on-duty floor staff
    poolRoles: { type: [String], default: ['WAITER', 'HEAD_WAITER', 'BARTENDER'] },
  },
  // What this business runs. The owner chooses; switching it only turns the accommodation module on or off (nothing is deleted).
  serviceMode: { type: String, enum: SERVICE_MODES, default: 'RESTAURANT' },
  // What a guest may do after scanning a table or room QR code.
  guestOrdering: {
    tableMode: { type: String, enum: GUEST_MODES, default: 'ORDER_CONFIRM' },
    roomMode: { type: String, enum: GUEST_MODES, default: 'ORDER_CONFIRM' },
    maxAutoOrderCents: { type: Number, default: 0, min: 0 },           // ORDER_AUTO only: larger orders wait for a waiter (0 = no limit)
    selfSeat: { type: Boolean, default: false },                       // a guest may open an empty table by ordering (otherwise a waiter must seat them first)
    requireName: { type: Boolean, default: false },
    requirePhone: { type: Boolean, default: false },
    maxItemsPerRequest: { type: Number, default: 30, min: 1, max: 100 },
    maxQuantityPerItem: { type: Number, default: 20, min: 1, max: 200 },
    allowNotes: { type: Boolean, default: true },
    showPrices: { type: Boolean, default: true },
    allowBillRequest: { type: Boolean, default: true },
    callCooldownSeconds: { type: Number, default: 60, min: 0, max: 3600 },   // the same call from the same place is merged inside this window
    requestExpiryMinutes: { type: Number, default: 20, min: 2, max: 240 },   // an order nobody accepted is withdrawn
    baseUrl: { type: String, trim: true, maxlength: 200 },             // where the guest web page lives, e.g. https://order.mycafe.co.ke (falls back to GUEST_APP_URL)
    welcomeMessage: { type: String, trim: true, maxlength: 300 },
    welcomeMessageSw: { type: String, trim: true, maxlength: 300 },
  },
  // The business storefront: ONE QR code for the whole business (delivery, table reservations, room booking, offers).
  storefront: {
    enabled: { type: Boolean, default: false },
    qrVersion: { type: Number, default: 1 },
    tagline: { type: String, trim: true, maxlength: 120 },
    welcomeMessage: { type: String, trim: true, maxlength: 300 },
    themeColor: { type: String, default: '#0f766e' },
    branchLocations: [{ _id: false, branchId: { type: Schema.Types.ObjectId, ref: 'Branch' }, lat: Number, lng: Number }],
    delivery: {
      enabled: { type: Boolean, default: true }, paused: { type: Boolean, default: false },
      mode: { type: String, enum: ['AUTO', 'CONFIRM'], default: 'AUTO' },          // AUTO = straight to the kitchen; CONFIRM = staff open the order and send it
      baseFeeCents: { type: Number, default: 0, min: 0 }, perKmCents: { type: Number, default: 0, min: 0 }, minOrderCents: { type: Number, default: 0, min: 0 },
      maxRadiusKm: { type: Number, default: 0, min: 0, max: 500 }, minutesPerKm: { type: Number, default: 3, min: 0, max: 30 }, bufferMinutes: { type: Number, default: 10, min: 0, max: 120 },
      hoursStart: { type: String }, hoursEnd: { type: String },
    },
    tables: { enabled: { type: Boolean, default: true }, openTime: { type: String, default: '10:00' }, closeTime: { type: String, default: '22:00' }, slotMinutes: { type: Number, default: 30, min: 15, max: 240 }, minLeadMinutes: { type: Number, default: 30, min: 0, max: 1440 }, maxAdvanceDays: { type: Number, default: 30, min: 1, max: 365 } },
    rooms: { enabled: { type: Boolean, default: true } },
  },
  stockDepletionEvent: { type: String, enum: STOCK_DEPLETION_EVENTS, default: 'ON_SEND' },
  stockLocations: { type: String, enum: ['SINGLE', 'MULTI'], default: 'SINGLE' }, // SINGLE: one store; MULTI: store + kitchen + bar
  allowNegativeIngredients: { type: Boolean, default: true },   // a missing ingredient record must never stop a customer being served
  hideOutOfStockItems: { type: Boolean, default: false },       // menu shows RECIPE items with no possible portions as unavailable
  kitchenDelayMinutes: { type: Number, default: 20, min: 1, max: 240 },
  discounts: {
    waiterMaxPercent: { type: Number, default: 0, min: 0, max: 100 },
    cashierMaxPercent: { type: Number, default: 5, min: 0, max: 100 },
    supervisorMaxPercent: { type: Number, default: 10, min: 0, max: 100 },
    managerMaxPercent: { type: Number, default: 30, min: 0, max: 100 },
  },
  requireTableCleaning: { type: Boolean, default: false },
  paymentsRequireShift: { type: Boolean, default: true },       // cash needs an open CashShift (same rule as the till)
  reservation: {
    durationMinutes: { type: Number, default: 90, min: 15, max: 600 },
    holdMinutes: { type: Number, default: 15, min: 0, max: 120 },   // late this long and it can be marked no-show
    depositRequired: { type: Boolean, default: false },
    depositCents: { type: Number, default: 0, min: 0 },
    remindMinutes: { type: Number, default: 60, min: 0, max: 1440 },
  },
}, { timestamps: true });

module.exports = model('RestaurantSettings', restaurantSettingsSchema);
