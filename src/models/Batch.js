const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const batchSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

    // Stock pool: RETAIL (sellable shop floor, default) or WAREHOUSE (wholesale store; never sold directly).
    location: { type: String, enum: ['RETAIL', 'WAREHOUSE'], default: 'RETAIL' },

    batchNumber: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0 }, // remaining quantity in this batch
    costPrice: { type: Number, default: 0 }, // integer cents, cost at time of receiving this batch

    manufacturingDate: { type: Date },
    expiryDate: { type: Date },

    // active      = sellable (its quantity is part of BranchInventory.quantity)
    // quarantined = held back (recall, damage, returned stock awaiting inspection); NOT in BranchInventory.quantity
    // recalled    = quarantined because of a supplier/regulator recall
    // expired / depleted = written off / used up
    status: { type: String, enum: ['active', 'quarantined', 'recalled', 'expired', 'depleted'], default: 'active' },
    statusReason: { type: String, trim: true },
    statusChangedAt: { type: Date },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    receivedAt: { type: Date },
    parentBatchId: { type: Schema.Types.ObjectId, ref: 'Batch' }, // set on return-to-quarantine batches
  },
  { timestamps: true }
);

// Same batch number may exist once in the warehouse AND once in retail (run scripts/migrate-warehouse.js to replace the old index).
batchSchema.index({ businessId: 1, branchId: 1, productId: 1, batchNumber: 1, location: 1 }, { unique: true });
batchSchema.index({ businessId: 1, expiryDate: 1 });
batchSchema.index({ businessId: 1, branchId: 1, productId: 1, status: 1, expiryDate: 1 });

moneyFields(batchSchema, ['costPrice']);

module.exports = model('Batch', batchSchema);