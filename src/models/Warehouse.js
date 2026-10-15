const { Schema, model } = require('mongoose');

/**
 * A WAREHOUSE (wholesale store). A business can have as many as it needs, in any branch.
 * Stock lives in WarehouseInventory rows keyed by (warehouseId, product, variant).
 * Each branch has at most ONE default warehouse, used whenever a request does not name a warehouse
 * (so older clients that never heard of warehouses keep working).
 * allowSales=false -> pure storage/overflow warehouse: it cannot be sold from in WHOLESALE mode.
 */
const warehouseSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    address: { type: String, trim: true, maxlength: 200 },
    phone: { type: String, trim: true, maxlength: 30 },
    notes: { type: String, trim: true, maxlength: 500 },
    managerId: { type: Schema.Types.ObjectId, ref: 'User' },
    isDefault: { type: Boolean, default: false },
    allowSales: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

warehouseSchema.index({ businessId: 1, code: 1 }, { unique: true });
warehouseSchema.index({ businessId: 1, branchId: 1, status: 1 });
// at most one default warehouse per branch
warehouseSchema.index({ businessId: 1, branchId: 1, isDefault: 1 }, { unique: true, partialFilterExpression: { isDefault: true } });

module.exports = model('Warehouse', warehouseSchema);
