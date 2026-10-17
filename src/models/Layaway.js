const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const STATUSES = ['ACTIVE', 'COMPLETED', 'CANCELLED'];

/** One reserved line. Price, tax and cost are LOCKED at reservation: the customer pays what was agreed. */
const itemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  nameSnapshot: { type: String, required: true },
  skuSnapshot: { type: String, required: true },
  barcodeSnapshot: { type: String },
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true },        // integer cents
  costPriceSnapshot: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  taxAmount: { type: Number, default: 0 },
  total: { type: Number, required: true },
  stockReserved: { type: Boolean, default: false },   // units are held in BranchInventory.reservedQuantity
  serialNumbers: [{ type: String }],                  // specific units held (status 'reserved')
}, { _id: true });

const paymentSchema = new Schema({
  type: { type: String, enum: ['DEPOSIT', 'INSTALMENT', 'REFUND'], required: true },
  method: { type: String, enum: ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'], required: true },
  amount: { type: Number, required: true, min: 1 },
  reference: { type: String },
  provider: { type: String },  // MOBILE_MONEY: which rail (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa...)
  at: { type: Date, default: Date.now },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  verified: { type: Boolean, default: false },
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
}, { _id: true });

const historySchema = new Schema({
  at: { type: Date, default: Date.now },
  event: { type: String },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  note: { type: String },
}, { _id: false });

const layawaySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    number: { type: String, required: true },

    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },     // snapshots, for SMS and receipts
    customerPhone: { type: String, required: true },

    items: { type: [itemSchema], required: true, validate: (v) => v.length > 0 },
    subtotal: { type: Number, required: true },
    itemDiscount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },            // what the customer agreed to pay
    taxInclusive: { type: Boolean, default: true },

    // Terms snapshotted when the layaway was opened, so a later settings change never rewrites an agreement.
    terms: {
      minDepositPercent: { type: Number },
      cancellationFeePercent: { type: Number },
      graceDays: { type: Number },
    },
    dueDate: { type: Date, required: true },
    originalDueDate: { type: Date },
    extensions: [{ _id: false, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, from: Date, to: Date, reason: String }],

    status: { type: String, enum: STATUSES, default: 'ACTIVE', index: true },

    payments: { type: [paymentSchema], default: [] },
    paid: { type: Number, default: 0 },                 // net of refunds
    balance: { type: Number, default: 0 },              // total - paid (0 once fully paid)

    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },         // the invoice (revenue) created at collection
    collectedAt: { type: Date },
    collectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    collectedByName: { type: String },
    collectorIdChecked: { type: Boolean },

    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelReason: { type: String },
    cancelledByCustomer: { type: Boolean },
    feeRetained: { type: Number, default: 0 },          // kept from the customer's payments on cancellation
    feeSaleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    refundedOnCancel: { type: Number, default: 0 },

    notes: { type: String },
    history: { type: [historySchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

layawaySchema.index({ businessId: 1, number: 1 }, { unique: true });
layawaySchema.index({ businessId: 1, branchId: 1, status: 1, dueDate: 1 });
layawaySchema.index({ businessId: 1, customerId: 1, createdAt: -1 });

moneyFields(layawaySchema, ['subtotal', 'itemDiscount', 'tax', 'total', 'paid', 'balance', 'feeRetained', 'refundedOnCancel'], {
  items: ['unitPrice', 'costPriceSnapshot', 'discount', 'taxAmount', 'total'], payments: ['amount'],
});

module.exports = model('Layaway', layawaySchema);
module.exports.STATUSES = STATUSES;