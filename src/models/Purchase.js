const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const attachmentSchema = new Schema(
  {
    url: { type: String, required: true },
    publicId: { type: String },
    originalName: { type: String },
    size: { type: Number },
    mimeType: { type: String },
    resourceType: { type: String, enum: ['image', 'raw'], default: 'raw' },
  },
  { _id: false }
);

const purchaseItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
    nameSnapshot: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0.001 },
    unitCost: { type: Number, required: true },
    taxRate: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    receivedQuantity: { type: Number, default: 0 },
  },
  { _id: false }
);

const purchaseSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },

    purchaseNumber: { type: String, required: true },
    invoiceNumber: { type: String, trim: true },

    vatMode: { type: String, enum: ['NONE', 'INCLUSIVE', 'EXCLUSIVE'], default: 'NONE' },
    vatRate: { type: Number, default: 0 },
    attachments: [attachmentSchema],

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