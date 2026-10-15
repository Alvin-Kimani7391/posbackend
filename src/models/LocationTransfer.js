const { Schema, model } = require('mongoose');

/**
 * A move of stock between two STOCK POOLS of the business, instant and atomic (one transaction):
 *   TO_RETAIL               warehouse -> shop floor (the owner "sells to himself" and sets the new RETAIL price)
 *   TO_WAREHOUSE            shop floor -> warehouse (a return to warehouse stock)
 *   WAREHOUSE_TO_WAREHOUSE  between two warehouses
 * (Branch-to-branch RETAIL moves stay in StockTransfer.)
 *
 * UNIT CONVERSION: a line is entered in any unit of the product ("2 bundles"); `quantity` / baseQuantity is what
 * actually moved (48 packets). NO PROFIT is booked by a transfer: goods move at COST; profit appears only when they are
 * SOLD at the retail price set here (retailPriceCents), in the sales / profit reports.
 */
const endpointSchema = new Schema(
  {
    location: { type: String, enum: ['WAREHOUSE', 'RETAIL'], required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
    warehouseName: { type: String },
  },
  { _id: false }
);

const itemSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    nameSnapshot: { type: String },
    quantity: { type: Number, required: true, min: 0 }, // BASE units that moved
    unitId: { type: Schema.Types.ObjectId },
    unitName: { type: String },          // the unit the line was entered in
    unitFactor: { type: Number },
    enteredQuantity: { type: Number },   // quantity in that unit
    baseUnitName: { type: String },
    unitCostCents: { type: Number, default: 0 }, // cost per BASE unit
    // warehouse -> retail only: the retail price set for the shop floor (per base unit)
    retailPriceCents: { type: Number },
    previousRetailPriceCents: { type: Number },
    priceFloorCents: { type: Number },
    priceFloorKind: { type: String, enum: ['WHOLESALE', 'COST'] },
    expectedProfitPerUnitCents: { type: Number },
    batchAllocations: [{ _id: false, batchId: { type: Schema.Types.ObjectId, ref: 'Batch' }, batchNumber: String, expiryDate: Date, quantity: Number }],
    serialNumbers: [String],
  },
  { _id: false }
);

const locationTransferSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true }, // source branch
    transferNumber: { type: String, required: true },
    kind: { type: String, enum: ['TO_RETAIL', 'TO_WAREHOUSE', 'WAREHOUSE_TO_WAREHOUSE'] }, // older documents have none
    fromLocation: { type: String, enum: ['WAREHOUSE', 'RETAIL'], required: true },
    toLocation: { type: String, enum: ['WAREHOUSE', 'RETAIL'], required: true },
    from: { type: endpointSchema },
    to: { type: endpointSchema },
    items: { type: [itemSchema], required: true, validate: (v) => v.length > 0 },
    notes: { type: String },
    performedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

locationTransferSchema.index({ businessId: 1, transferNumber: 1 }, { unique: true });
locationTransferSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });
locationTransferSchema.index({ businessId: 1, 'from.warehouseId': 1, 'to.warehouseId': 1 });

module.exports = model('LocationTransfer', locationTransferSchema);
