const { Schema, model } = require('mongoose');

/**
 * A customer's warranty claim on ONE serialised unit.
 *   OPEN      reported, waiting for a decision
 *   APPROVED  repair approved; a (free) RepairJob is open
 *   REJECTED  claim refused (reason recorded)
 *   RESOLVED  finished: unit replaced, or the warranty repair was collected
 */
const warrantyClaimSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    claimNumber: { type: String, required: true },

    serialId: { type: Schema.Types.ObjectId, ref: 'SerialNumber', required: true },
    serialNumber: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    nameSnapshot: { type: String },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String },
    customerPhone: { type: String },

    fault: { type: String, required: true, trim: true },
    coverage: { type: String, enum: ['SHOP', 'EXPIRED'], required: true }, // at the time of the claim
    warrantyEndAtClaim: { type: Date },

    status: { type: String, enum: ['OPEN', 'APPROVED', 'REJECTED', 'RESOLVED'], default: 'OPEN' },
    decision: { type: String, enum: ['REPAIR', 'REPLACEMENT', 'REJECT'] },
    decisionReason: { type: String, trim: true },
    goodwill: { type: Boolean, default: false }, // approved although the warranty had expired
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },

    replacementSerialId: { type: Schema.Types.ObjectId, ref: 'SerialNumber' },
    replacementSerialNumber: { type: String },
    repairJobId: { type: Schema.Types.ObjectId, ref: 'RepairJob' },

    // Claim against the SUPPLIER's warranty (return of the faulty unit for credit / replacement).
    supplierRma: {
      reference: { type: String },
      sentAt: { type: Date },
      outcome: { type: String, enum: ['PENDING', 'CREDITED', 'REPLACED', 'REJECTED'], default: undefined },
      note: { type: String },
    },

    resolvedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

warrantyClaimSchema.index({ businessId: 1, claimNumber: 1 }, { unique: true });
warrantyClaimSchema.index({ businessId: 1, serialId: 1, status: 1 });
warrantyClaimSchema.index({ businessId: 1, status: 1, createdAt: -1 });

module.exports = model('WarrantyClaim', warrantyClaimSchema);