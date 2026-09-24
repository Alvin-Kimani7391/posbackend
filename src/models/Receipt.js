const { Schema, model } = require('mongoose');

const receiptSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, unique: true },

    receiptNumber: { type: String, required: true },
    invoiceNumber: { type: String },

    // Fully self-contained snapshot - a thermal/PDF/SMS renderer needs
    // nothing else. Never re-fetch business/product/customer data to
    // render a historical receipt; use exactly what's stored here.
    //
    // `business` is a snapshot of Business.receiptSettings AS THEY WERE AT
    // SALE TIME - if the owner changes the footer message or toggles
    // showKraPin tomorrow, yesterday's receipt must not change.
    receiptData: {
      business: {
        name: String, address: String, phone: String, kraPin: String,
        footerMessage: String, headerMessage: String, logo: String,
        showKraPin: Boolean, showCashierName: Boolean, showMpesaReceiptCode: Boolean,
        customLines: [String], paperWidth: String,
      },
      branch: { name: String, phone: String },
      cashier: { name: String },
      customer: { name: String, phone: String },
      items: [{
        name: String, sku: String, quantity: Number, unitPrice: Number,
        discount: Number, taxRate: Number, taxAmount: Number, total: Number,
      }],
      subtotal: Number,
      itemDiscount: Number,
      cartDiscount: Number,
      tax: Number,
      total: Number,
      payments: [{ method: String, amount: Number, reference: String, externalTransactionId: String }],
      amountTendered: Number,
      changeGiven: Number,
      balance: Number,
      paymentStatus: String,
      etims: { type: Schema.Types.Mixed, default: null }, // populated once eTIMS integration lands
    },

    printedAt: { type: Date },
    printCount: { type: Number, default: 0 },
    emailSentAt: { type: Date },
    smsSentAt: { type: Date },
    whatsappSentAt: { type: Date },
  },
  { timestamps: true }
);

receiptSchema.index({ businessId: 1, receiptNumber: 1 });

// receiptData nests its money fields inside an object (and inside its own
// items/payments arrays), which the generic moneySchemaPlugin doesn't reach
// (it only handles top-level fields and one level of array-of-subdocuments).
// So Receipt gets its own transform converting exactly those nested cents
// fields to decimal KES on output - everything else in receiptData passes
// through untouched (externalTransactionId is a string, not money, so it's
// never touched by this transform).
const { fromCents } = require('../utils/money');

function convertReceiptMoney(ret) {
  const d = ret.receiptData;
  if (!d) return ret;
  ['subtotal', 'itemDiscount', 'cartDiscount', 'tax', 'total', 'amountTendered', 'changeGiven', 'balance'].forEach((f) => {
    if (d[f] !== undefined && d[f] !== null) d[f] = fromCents(d[f]);
  });
  if (Array.isArray(d.items)) {
    d.items = d.items.map((item) => {
      const copy = { ...item };
      ['unitPrice', 'discount', 'taxAmount', 'total'].forEach((f) => {
        if (copy[f] !== undefined && copy[f] !== null) copy[f] = fromCents(copy[f]);
      });
      return copy;
    });
  }
  if (Array.isArray(d.payments)) {
    d.payments = d.payments.map((p) => ({ ...p, amount: fromCents(p.amount) }));
  }
  return ret;
}

receiptSchema.set('toJSON', { transform: (doc, ret) => convertReceiptMoney(ret), virtuals: true });
receiptSchema.set('toObject', { transform: (doc, ret) => convertReceiptMoney(ret), virtuals: true });

module.exports = model('Receipt', receiptSchema);