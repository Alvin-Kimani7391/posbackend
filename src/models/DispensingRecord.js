const { Schema, model } = require('mongoose');

/**
 * One dispensing = one Sale. Links prescription, patient, dispenser, sale and the exact stock batch(es). Never edited:
 * a correction is a REVERSAL with a reason (the medicine goes to quarantine, never straight back on the shelf).
 */
const dispensingSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true },
    prescriptionId: { type: Schema.Types.ObjectId, ref: 'Prescription', required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    dispenserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dispenserSnapshot: { type: new Schema({ name: String, role: String, registrationNumber: String }, { _id: false }) },
    items: [{
      _id: false,
      productId: { type: Schema.Types.ObjectId, ref: 'Product' },
      nameSnapshot: String, strength: String, dosageForm: String,
      quantity: Number, directions: String,
      batchAllocations: [{ _id: false, batchId: Schema.Types.ObjectId, batchNumber: String, expiryDate: Date, quantity: Number }],
    }],
    countersign: { type: new Schema({ name: String, relationship: String, at: Date }, { _id: false }), default: undefined }, // controlled drugs: patient / representative countersigned
    status: { type: String, enum: ['DISPENSED', 'REVERSED'], default: 'DISPENSED' },
    reversal: { type: new Schema({ by: Schema.Types.ObjectId, at: Date, reason: String, refundId: Schema.Types.ObjectId }, { _id: false }) },
    labelPrints: { type: [new Schema({ at: Date, by: Schema.Types.ObjectId, reason: String }, { _id: false })], default: [] },
  },
  { timestamps: true }
);

dispensingSchema.index({ businessId: 1, number: 1 }, { unique: true });
dispensingSchema.index({ businessId: 1, createdAt: -1 });
dispensingSchema.index({ businessId: 1, 'items.batchAllocations.batchId': 1 });

module.exports = model('DispensingRecord', dispensingSchema);