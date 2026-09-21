const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const saleItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },

    // --- snapshots: captured at sale time, NEVER re-derived from the live
    // Product/ProductVariant document. If the product's price or name
    // changes tomorrow, this line on yesterday's receipt must not change. ---
    nameSnapshot: { type: String, required: true },
    skuSnapshot: { type: String, required: true },
    barcodeSnapshot: { type: String },

    quantity: { type: Number, required: true, min: 0.001 },
    unitPrice: { type: Number, required: true },        // integer cents, authoritative price at sale time
    costPriceSnapshot: { type: Number, required: true }, // integer cents, for profit calculation

    discount: { type: Number, default: 0 },   // integer cents, this line's share of item-level discount
    taxRate: { type: Number, default: 0 },    // percent, snapshotted from the product at sale time
    taxAmount: { type: Number, default: 0 },  // integer cents
    total: { type: Number, required: true },  // integer cents, this line's final total (after discount, tax-inclusive)

    refundedQuantity: { type: Number, default: 0 }, // running total already refunded - never let refunds exceed (quantity - refundedQuantity)

    batchId: { type: Schema.Types.ObjectId, ref: 'Batch' },
    serialNumbers: [{ type: String }],
  },
  { _id: false }
);

const saleSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },

    receiptNumber: { type: String, required: true },
    invoiceNumber: { type: String },

    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    shiftId: { type: Schema.Types.ObjectId, ref: 'CashShift' },

    items: { type: [saleItemSchema], required: true, validate: (v) => v.length > 0 },

    // --- money fields: integer cents ---
    subtotal: { type: Number, required: true },
    itemDiscount: { type: Number, default: 0 },
    cartDiscount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 }, // total - amountPaid (>0 means owed as credit)

    paymentStatus: { type: String, enum: ['PAID', 'PARTIAL', 'UNPAID', 'CREDIT'], default: 'PAID' },
    saleStatus: { type: String, enum: ['COMPLETED', 'CANCELLED'], default: 'COMPLETED' },

    source: { type: String, enum: ['POS', 'ONLINE', 'SYNC'], default: 'POS' },
    notes: { type: String },

    // Offline-sync dedup fields (full sync engine is a later phase, but the
    // dedup key is cheap to support from day one).
    clientTransactionId: { type: String },
    deviceId: { type: String },

    cancelledAt: { type: Date },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelReason: { type: String },
  },
  { timestamps: true }
);

saleSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });
saleSchema.index({ businessId: 1, receiptNumber: 1 }, { unique: true });
saleSchema.index({ businessId: 1, customerId: 1 });
saleSchema.index({ businessId: 1, cashierId: 1 });
// OLD - buggy, causes false duplicate-key collisions:
// saleSchema.index({ businessId: 1, branchId: 1, deviceId: 1, clientTransactionId: 1 }, { unique: true, sparse: true });

// NEW - only enforced when BOTH offline-sync fields are actually present,
// so ordinary sales (no deviceId/clientTransactionId) never collide.
saleSchema.index(
  { businessId: 1, branchId: 1, deviceId: 1, clientTransactionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      deviceId: { $type: 'string' },
      clientTransactionId: { $type: 'string' },
    },
  }
);

moneyFields(
  saleSchema,
  ['subtotal', 'itemDiscount', 'cartDiscount', 'tax', 'total', 'amountPaid', 'balance'],
  { items: ['unitPrice', 'costPriceSnapshot', 'discount', 'taxAmount', 'total'] }
);

module.exports = model('Sale', saleSchema);
