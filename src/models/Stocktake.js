const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

/**
 * A stocktake (physical count) for ONE branch.
 *   OPEN       counters enter counted quantities
 *   SUBMITTED  counting finished, waiting for a manager's review of the variances
 *   APPROVED   approved variances have been applied to stock (movements + audit); final
 *   CANCELLED  abandoned; nothing was changed
 *
 * Lines are per (product, variant) or, for batch-tracked products that have batches, per batch.
 * Variance = countedQty - systemQtyAtCount, where systemQtyAtCount is read when the line is counted. Approval
 * applies the DELTA (not an absolute overwrite), so sales made after the count are never wiped out.
 */
const lineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
    batchId: { type: Schema.Types.ObjectId, ref: 'Batch', default: null },
    batchNumber: { type: String },
    expiryDate: { type: Date },
    nameSnapshot: { type: String },
    skuSnapshot: { type: String },
    unitCostCents: { type: Number, default: 0 }, // integer cents, for valuing the variance

    systemQtyAtStart: { type: Number, default: 0 }, // reference only; hidden from counters in a blind count
    systemQtyAtCount: { type: Number }, // live system quantity when the count was entered
    countedQty: { type: Number, min: 0 },
    countedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    countedAt: { type: Date },
    recountCount: { type: Number, default: 0 },
    note: { type: String, trim: true },

    varianceQty: { type: Number, default: 0 },
    varianceValue: { type: Number, default: 0 }, // integer cents (negative = loss)

    decision: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
  },
  { _id: true }
);

const stocktakeSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    stocktakeNumber: { type: String, required: true },
    name: { type: String, trim: true },
    blind: { type: Boolean, default: true }, // counters do not see the system quantity
    scope: {
      type: { type: String, enum: ['ALL', 'CATEGORY', 'PRODUCTS'], default: 'ALL' },
      categoryIds: [{ type: Schema.Types.ObjectId, ref: 'Category' }],
      productIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    },
    status: { type: String, enum: ['OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED'], default: 'OPEN' },
    lines: { type: [lineSchema], default: [] },

    startedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    approvalNote: { type: String, trim: true },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    cancelReason: { type: String, trim: true },

    totalVarianceValue: { type: Number, default: 0 }, // integer cents, net of approved lines
  },
  { timestamps: true }
);

stocktakeSchema.index({ businessId: 1, stocktakeNumber: 1 }, { unique: true });
stocktakeSchema.index({ businessId: 1, branchId: 1, status: 1 });

moneyFields(stocktakeSchema, ['totalVarianceValue'], { lines: ['unitCostCents', 'varianceValue'] });

module.exports = model('Stocktake', stocktakeSchema);