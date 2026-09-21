const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const purchaseItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
    nameSnapshot: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unitCost: { type: Number, required: true }, // integer cents - what was actually paid, entered by the storekeeper
    taxRate: { type: Number, default: 0 },
    discount: { type: Number, default: 0 }, // integer cents
    total: { type: Number, required: true }, // integer cents, computed server-side from the above (never trusted raw from the client)
    receivedQuantity: { type: Number, default: 0 }, // how much of this line has actually been received into stock so far
  },
  { _id: false }
);

const purchaseSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },

    purchaseNumber: { type: String, required: true },
    invoiceNumber: { type: String, trim: true }, // the SUPPLIER's invoice number, not ours

    items: { type: [purchaseItemSchema], required: true, validate: (v) => v.length > 0 },

    subtotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, required: true },
    amountPaid: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },

    paymentStatus: { type: String, enum: ['UNPAID', 'PARTIAL', 'PAID'], default: 'UNPAID' },
    receivedStatus: { type: String, enum: ['PENDING', 'PARTIAL', 'RECEIVED'], default: 'PENDING' },

    purchaseDate: { type: Date, default: Date.now },
    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseSchema.index({ businessId: 1, purchaseNumber: 1 }, { unique: true });
purchaseSchema.index({ businessId: 1, supplierId: 1 });
purchaseSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });

moneyFields(
  purchaseSchema,
  ['subtotal', 'discount', 'tax', 'total', 'amountPaid', 'balance'],
  { items: ['unitCost', 'discount', 'total'] }
);

module.exports = model('Purchase', purchaseSchema);
