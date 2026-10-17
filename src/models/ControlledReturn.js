const { Schema, model } = require('mongoose');

/**
 * A period return of restricted medicines: opening, received, issued, closing (from the stock ledger), the physical count and
 * variance, signed by a pharmacist. A signed return is locked. This is the pharmacy's own record; the columns are fixed and
 * documented, and may need mapping to whatever template the Board currently asks for.
 */
const controlledReturnSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true },
    periodFrom: { type: Date, required: true }, periodTo: { type: Date, required: true },
    lines: [{
      _id: false, productId: Schema.Types.ObjectId, name: String, strength: String, dosageForm: String, classification: String,
      opening: Number, received: Number, issued: Number, closing: Number,
      countedQuantity: Number, variance: Number, note: String,
    }],
    status: { type: String, enum: ['DRAFT', 'SIGNED'], default: 'DRAFT' },
    signedBy: { type: Schema.Types.ObjectId, ref: 'User' }, signedAt: Date,
    signer: { type: new Schema({ name: String, role: String, registrationNumber: String }, { _id: false }) },
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
controlledReturnSchema.index({ businessId: 1, number: 1 }, { unique: true });
controlledReturnSchema.index({ businessId: 1, branchId: 1, periodTo: -1 });

module.exports = model('ControlledReturn', controlledReturnSchema);