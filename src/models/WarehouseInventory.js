const { Schema, model } = require('mongoose');

/**
 * WAREHOUSE (wholesale store) stock - one row per (branch, product, variant).
 * Same shape as BranchInventory, which keeps holding RETAIL (shop-floor) stock.
 *
 * The POS (sales, refunds, offline sync, job cards, repairs...) only ever touches BranchInventory, so warehouse
 * stock can never be sold by accident: it must be transferred to retail first (warehouse.service.js).
 * Every change goes through inventory.service#applyStockChange({ location: 'WAREHOUSE' }), which writes the
 * InventoryMovement ledger row tagged with the location, so warehouse stock is as traceable as retail stock.
 */
const warehouseInventorySchema = new Schema(
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

warehouseInventorySchema.index({ businessId: 1, branchId: 1, productId: 1, variantId: 1 }, { unique: true });
warehouseInventorySchema.index({ businessId: 1, branchId: 1, quantity: 1 });

warehouseInventorySchema.virtual('availableQuantity').get(function availableQuantity() {
  return this.quantity - this.reservedQuantity;
});
warehouseInventorySchema.set('toJSON', { virtuals: true });
warehouseInventorySchema.set('toObject', { virtuals: true });

module.exports = model('WarehouseInventory', warehouseInventorySchema);
