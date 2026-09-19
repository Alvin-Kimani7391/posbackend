const { Schema, model } = require('mongoose');

const transferItemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    quantity: { type: Number, required: true, min: 1 },
    nameSnapshot: { type: String },
  },
  { _id: false }
);

const stockTransferSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    transferNumber: { type: String, required: true },
    fromBranchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    toBranchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },

    items: { type: [transferItemSchema], required: true, validate: (v) => v.length > 0 },

    status: {
      type: String,
      enum: ['REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'],
      default: 'REQUESTED',
    },

    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    notes: { type: String },
  },
  { timestamps: true }
);

stockTransferSchema.index({ businessId: 1, transferNumber: 1 }, { unique: true });
stockTransferSchema.index({ businessId: 1, status: 1 });
stockTransferSchema.index({ businessId: 1, fromBranchId: 1 });
stockTransferSchema.index({ businessId: 1, toBranchId: 1 });

module.exports = model('StockTransfer', stockTransferSchema);
