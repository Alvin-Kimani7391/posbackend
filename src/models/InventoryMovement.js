const { Schema, model } = require('mongoose');

const MOVEMENT_TYPES = [
  'PURCHASE', 'SALE', 'RETURN', 'REFUND',
  'ADJUSTMENT_IN', 'ADJUSTMENT_OUT',
  'TRANSFER_IN', 'TRANSFER_OUT',
  'DAMAGE', 'EXPIRED', 'LOST', 'OPENING_STOCK',
];

const inventoryMovementSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

    type: { type: String, enum: MOVEMENT_TYPES, required: true },
    quantity: { type: Number, required: true }, // signed: positive = stock in, negative = stock out
    previousStock: { type: Number, required: true },
    newStock: { type: Number, required: true },

    referenceType: { type: String }, // e.g. 'Sale', 'Purchase', 'StockTransfer', 'Refund'
    referenceId: { type: Schema.Types.ObjectId },
    reason: { type: String },

    performedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

inventoryMovementSchema.index({ businessId: 1, branchId: 1, productId: 1, variantId: 1, createdAt: -1 });
inventoryMovementSchema.index({ businessId: 1, referenceType: 1, referenceId: 1 });

// Append-only: never editable or deletable once written.
inventoryMovementSchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany'], function blockUpdate(next) {
  next(new Error('InventoryMovement records are immutable and cannot be updated'));
});
inventoryMovementSchema.pre(['deleteOne', 'findOneAndDelete', 'deleteMany'], function blockDelete(next) {
  next(new Error('InventoryMovement records are immutable and cannot be deleted'));
});

const InventoryMovement = model('InventoryMovement', inventoryMovementSchema);
module.exports = InventoryMovement;
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
