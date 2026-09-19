const { Schema, model } = require('mongoose');

const branchInventorySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

    quantity: { type: Number, required: true, default: 0 },
    reservedQuantity: { type: Number, required: true, default: 0 },
    lowStockThreshold: { type: Number, default: 5 },
  },
  { timestamps: true }
);

// One row per (branch, product, variant). variantId is null for products
// without variants, so this index also guarantees no duplicate rows there.
branchInventorySchema.index({ businessId: 1, branchId: 1, productId: 1, variantId: 1 }, { unique: true });
branchInventorySchema.index({ businessId: 1, branchId: 1, quantity: 1 });

// availableQuantity is derived, never stored, so it can never drift out of
// sync with quantity/reservedQuantity.
branchInventorySchema.virtual('availableQuantity').get(function availableQuantity() {
  return this.quantity - this.reservedQuantity;
});

branchInventorySchema.set('toJSON', { virtuals: true });
branchInventorySchema.set('toObject', { virtuals: true });

module.exports = model('BranchInventory', branchInventorySchema);
