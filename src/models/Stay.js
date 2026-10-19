const { Schema, model } = require('mongoose');
const H = require('../constants/hospitality');
const moneyPaths = require('../utils/moneyDeepPlugin');

/** One line on the guest's folio. Totals are stored per line so the stay invoice can be printed exactly as posted. */
const folioLine = new Schema({
  type: { type: String, enum: H.FOLIO_TYPES, required: true },
  description: { type: String, required: true, trim: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  sku: String,
  quantity: { type: Number, default: 1 },
  unitPrice: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  gross: { type: Number, default: 0 }, taxAmount: { type: Number, default: 0 }, total: { type: Number, default: 0 }, cost: { type: Number, default: 0 },
  nightDate: String,                                                  // YYYY-MM-DD, for ROOM lines
  source: { type: String, enum: ['AUTO', 'MANUAL', 'ORDER', 'FEE', 'POLICY'], default: 'MANUAL' },
  orderId: Schema.Types.ObjectId, billId: Schema.Types.ObjectId, billNumber: String,
  postedAt: { type: Date, default: Date.now }, postedBy: Schema.Types.ObjectId,
  voided: { type: Boolean, default: false }, voidReason: String, voidedBy: Schema.Types.ObjectId, voidedAt: Date,
});

const stayPayment = new Schema({
  kind: { type: String, enum: ['DEPOSIT', 'PAYMENT', 'REFUND'], default: 'PAYMENT' },
  method: { type: String, enum: [...H.STAY_PAY_METHODS], required: true },
  amount: { type: Number, required: true, min: 1 },
  tendered: Number, change: Number, reference: String,
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
  verified: { type: Boolean, default: false },
  at: { type: Date, default: Date.now }, by: Schema.Types.ObjectId, note: String,
  network: { type: String, trim: true }, payerPhone: { type: String, trim: true },
  verifyStatus: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'] }, verifiedBy: Schema.Types.ObjectId, verifiedAt: Date, verifyNote: String,
});

const guestSchema = new Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, trim: true }, email: { type: String, trim: true, lowercase: true },
  idType: { type: String, enum: H.ID_TYPES }, idNumber: { type: String, trim: true },
  nationality: { type: String, trim: true }, address: { type: String, trim: true }, company: { type: String, trim: true },
  vehiclePlate: { type: String, trim: true, uppercase: true },
}, { _id: false });

const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  stayNumber: { type: String, required: true },
  bookingCode: { type: String, required: true },                      // short code the guest quotes; also proves identity for self check-in
  groupId: { type: String },                                          // links several rooms booked together
  status: { type: String, enum: H.STAY_STATUS, default: 'RESERVED' },
  source: { type: String, enum: H.BOOKING_SOURCES, default: 'WALK_IN' },
  roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
  roomNumber: String,
  roomTypeId: { type: Schema.Types.ObjectId, ref: 'RoomType' }, roomTypeName: String,
  guest: { type: guestSchema, required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  adults: { type: Number, default: 1, min: 1 }, children: { type: Number, default: 0, min: 0 },
  otherGuests: [{ _id: false, name: String, idType: { type: String, enum: H.ID_TYPES }, idNumber: String }],
  mealPlan: { type: String, enum: H.MEAL_PLANS, default: 'ROOM_ONLY' },
  specialRequests: { type: String, trim: true }, notes: { type: String, trim: true },

  checkInDate: { type: String, required: true },                      // YYYY-MM-DD (business time zone)
  checkOutDate: { type: String, required: true },
  nights: { type: Number, default: 1 },
  dayUse: { type: Boolean, default: false },
  expectedCheckIn: { type: Date, required: true },
  expectedCheckOut: { type: Date, required: true },
  actualCheckIn: Date, actualCheckOut: Date,
  policy: { _id: false, checkInTime: String, checkOutTime: String, timeZone: String },   // the times that applied when it was booked
  rate: {
    nightly: [{ _id: false, date: String, amount: Number, label: String }],
    overridden: { type: Boolean, default: false }, overrideReason: String, overrideBy: Schema.Types.ObjectId,
  },
  folio: { type: [folioLine], default: [] },
  payments: { type: [stayPayment], default: [] },
  depositRequired: { type: Number, default: 0 },
  totals: { charges: { type: Number, default: 0 }, tax: { type: Number, default: 0 }, paid: { type: Number, default: 0 }, credit: { type: Number, default: 0 }, waived: { type: Number, default: 0 }, balance: { type: Number, default: 0 } },
  creditCustomerId: Schema.Types.ObjectId,

  guestPinHash: { type: String, select: false },
  pinFailures: { type: Number, default: 0 }, pinLockedUntil: Date,
  qrOrdersEnabled: { type: Boolean, default: true },
  checkoutRequestedAt: Date,
  selfCheckIn: { at: Date },
  cancellation: { at: Date, by: Schema.Types.ObjectId, reason: String, fee: { type: Number, default: 0 } },
  noShowAt: Date, overdueNotifiedAt: Date,
  closeUnpaid: { amount: Number, reason: String, by: Schema.Types.ObjectId },
  saleId: { type: Schema.Types.ObjectId, ref: 'Sale' }, receiptNumber: String, invoiceNumber: String,
  clientRef: String,                                                  // idempotent create from a flaky connection
  version: { type: Number, default: 1 },
  history: [{ _id: false, at: { type: Date, default: Date.now }, action: String, by: Schema.Types.ObjectId, note: String }],
  createdBy: Schema.Types.ObjectId,
}, { timestamps: true });

s.index({ businessId: 1, branchId: 1, stayNumber: 1 }, { unique: true });
s.index({ businessId: 1, bookingCode: 1 }, { unique: true });
s.index({ businessId: 1, roomId: 1, status: 1 });
s.index({ businessId: 1, branchId: 1, status: 1, expectedCheckIn: 1 });
s.index({ businessId: 1, branchId: 1, status: 1, expectedCheckOut: 1 });
s.index({ businessId: 1, clientRef: 1 }, { unique: true, partialFilterExpression: { clientRef: { $type: 'string' } } });
s.index({ businessId: 1, 'guest.phone': 1 });

moneyPaths(s, ['rate.nightly.amount', 'depositRequired', 'totals.charges', 'totals.tax', 'totals.paid', 'totals.credit', 'totals.waived', 'totals.balance', 'cancellation.fee', 'closeUnpaid.amount',
  'folio.unitPrice', 'folio.gross', 'folio.taxAmount', 'folio.total', 'folio.cost', 'payments.amount', 'payments.tendered', 'payments.change']);
module.exports = model('Stay', s);
