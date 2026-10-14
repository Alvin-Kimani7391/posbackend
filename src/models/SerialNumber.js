const { Schema, model } = require('mongoose');

/**
 * One document per physical unit of a serialised product (phone, laptop, TV...).
 * Lifecycle:  in_stock -> sold -> (returned -> in_stock | damaged)   ;  in_stock -> damaged
 *   returned = customer brought it back; NOT sellable and NOT in stock until someone inspects it.
 * Every change is appended to `history`, so the full life of the unit can be traced from its serial / IMEI.
 */
const historySchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    type: { type: String, required: true }, // RECEIVED, SOLD, SALE_CANCELLED, RETURNED, INSPECTED_RESTOCK, INSPECTED_DAMAGED, WARRANTY_CLAIM, REPLACED_BY, REPLACEMENT_FOR, REPAIR_IN, REPAIR_OUT
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    refType: { type: String },
    refId: { type: Schema.Types.ObjectId },
    note: { type: String },
  },
  { _id: false }
);

const serialNumberSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },

    serialNumber: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ['in_stock', 'sold', 'damaged', 'returned'], default: 'in_stock' },
    condition: { type: String, enum: ['new', 'used', 'refurbished'], default: 'new' },

    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase' },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
    costPrice: { type: Number, default: 0 }, // integer cents (raw)
    receivedAt: { type: Date },

    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    soldAt: { type: Date },

    // Shop warranty (what the customer gets) and supplier warranty (what the shop gets) are tracked separately.
    warrantyStart: { type: Date },
    warrantyEnd: { type: Date },
    supplierWarrantyEnd: { type: Date },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true }
);

// Unique per business (not per branch): a serial can only exist once anywhere in the business.
serialNumberSchema.index({ businessId: 1, serialNumber: 1 }, { unique: true });
serialNumberSchema.index({ businessId: 1, branchId: 1, productId: 1, status: 1 });
serialNumberSchema.index({ businessId: 1, customerId: 1 });
serialNumberSchema.index({ businessId: 1, warrantyEnd: 1 });

module.exports = model('SerialNumber', serialNumberSchema);