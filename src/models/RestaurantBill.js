const { Schema, model } = require('mongoose');
const C = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');

const lineSchema = new Schema({
  orderItemId: { type: Schema.Types.ObjectId, required: true }, menuItemId: Schema.Types.ObjectId, productId: Schema.Types.ObjectId, sku: String,
  categoryId: Schema.Types.ObjectId, categoryName: String, name: String, variantName: String, modifiersText: String,
  quantity: Number, unitPrice: Number, taxRate: Number, serviceChargeable: Boolean, seatNumber: Number, isComp: Boolean,
  gross: Number, discount: Number, taxAmount: Number, total: Number, cost: Number, compValue: Number,
}, { _id: false });

const paymentSchema = new Schema({
  kind: { type: String, enum: ['PAYMENT', 'REFUND'], default: 'PAYMENT' },
  method: { type: String, enum: C.BILL_PAY_METHODS, required: true },
  amount: { type: Number, required: true, min: 1 },
  tendered: Number, change: Number, reference: String,
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' }, reservationId: Schema.Types.ObjectId, stayId: Schema.Types.ObjectId,
  verified: { type: Boolean, default: false }, at: { type: Date, default: Date.now }, by: Schema.Types.ObjectId,
  network: { type: String, trim: true }, payerPhone: { type: String, trim: true },
  verifyStatus: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'] }, verifiedBy: Schema.Types.ObjectId, verifiedAt: Date, verifyNote: String,
});

const billSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'RestaurantOrder', required: true },
  billNumber: { type: String, required: true },
  orderNumber: String, orderType: String, tableName: String, waiterId: Schema.Types.ObjectId, waiterName: String, guestCount: Number,
  parentBillId: Schema.Types.ObjectId, label: String, splitMode: String,
  taxInclusive: { type: Boolean, default: true },
  lines: { type: [lineSchema], default: [] },
  scPercent: { type: Number, default: 0 }, scTaxRate: { type: Number, default: 0 }, scWaived: { type: Boolean, default: false }, scWaivedBy: Schema.Types.ObjectId, scWaiveReason: String,
  discountInfo: { type: { type: String }, value: Number, amount: Number, reason: String, approvedBy: Schema.Types.ObjectId, at: Date },
  gross: { type: Number, default: 0 }, discount: { type: Number, default: 0 }, itemsTotal: { type: Number, default: 0 },
  serviceCharge: { type: Number, default: 0 }, serviceChargeTax: { type: Number, default: 0 }, tax: { type: Number, default: 0 },
  total: { type: Number, default: 0 }, cost: { type: Number, default: 0 }, compValue: { type: Number, default: 0 },
  payments: { type: [paymentSchema], default: [] },
  paid: { type: Number, default: 0 }, creditAmount: { type: Number, default: 0 }, waived: { type: Number, default: 0 }, waiveReason: String,
  balance: { type: Number, default: 0 },
  customerId: Schema.Types.ObjectId,
  status: { type: String, enum: C.BILL_STATUS, default: 'OPEN' },
  saleId: { type: Schema.Types.ObjectId, ref: 'Sale' }, receiptNumber: String,
  postedToStayId: { type: Schema.Types.ObjectId, ref: 'Stay' },            // charged to a guest's room: invoiced on the stay's check-out invoice, not as its own Sale
  issuedBy: Schema.Types.ObjectId, issuedAt: { type: Date, default: Date.now }, settledAt: Date, settledBy: Schema.Types.ObjectId,
  voidReason: String, voidedBy: Schema.Types.ObjectId,
  history: [{ _id: false, at: { type: Date, default: Date.now }, action: String, by: Schema.Types.ObjectId, note: String }],
}, { timestamps: true });

billSchema.index({ businessId: 1, branchId: 1, billNumber: 1 }, { unique: true });
billSchema.index({ businessId: 1, orderId: 1 });
billSchema.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
billSchema.index({ businessId: 1, saleId: 1 }, { sparse: true });

moneyPaths(billSchema, ['gross', 'discount', 'itemsTotal', 'serviceCharge', 'serviceChargeTax', 'tax', 'total', 'cost', 'compValue', 'paid', 'creditAmount', 'waived', 'balance',
  'discountInfo.amount', 'lines.unitPrice', 'lines.gross', 'lines.discount', 'lines.taxAmount', 'lines.total', 'lines.cost', 'lines.compValue', 'payments.amount', 'payments.tendered', 'payments.change']);

module.exports = model('RestaurantBill', billSchema);
