const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const refundItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
    nameSnapshot: { type: String, required: true },
    quantity: { type: Number, required: true, min: 0.001 }, // how many units are being returned/refunded on this line
    amount: { type: Number, required: true }, // integer cents - computed server-side, proportional to what was actually charged
  },
  { _id: false }
);

const refundSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },

    refundNumber: { type: String, required: true },
    items: { type: [refundItemSchema], required: true, validate: (v) => v.length > 0 },
    amount: { type: Number, required: true }, // integer cents, sum of items[].amount

    reason: { type: String, required: true, trim: true },
    paymentMethod: { type: String, enum: ['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER'], required: true }, // how the money is being given back

    status: { type: String, enum: ['REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED'], default: 'REQUESTED' },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String },
  },
  { timestamps: true }
);

refundSchema.index({ businessId: 1, refundNumber: 1 }, { unique: true });
refundSchema.index({ businessId: 1, saleId: 1 });
refundSchema.index({ businessId: 1, status: 1 });

moneyFields(refundSchema, ['amount'], { items: ['amount'] });

module.exports = model('Refund', refundSchema);
