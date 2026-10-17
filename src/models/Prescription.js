const { Schema, model } = require('mongoose');

/**
 * RECEIVED --pharmacist review--> VALIDATED --> PARTIALLY_DISPENSED --> DISPENSED
 *                    \--> REJECTED                  \--> CANCELLED / EXPIRED (any time before it is fully dispensed)
 * Quantities are in the medicine's BASE unit (tablet, ml...), the same unit stock is kept in.
 */
const itemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  nameSnapshot: String, genericName: String, strength: String, dosageForm: String,
  prescribedQty: { type: Number, required: true, min: 0.001 },
  dispensedQty: { type: Number, default: 0, min: 0 },
  directions: { type: String, trim: true },       // "1 tablet three times a day for 5 days"
});

const prescriptionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true },
    externalReference: { type: String, trim: true },  // the number on the paper / e-prescription
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    prescriber: {
      type: new Schema({ name: { type: String, required: true }, registrationNumber: String, facility: String, phone: String }, { _id: false }),
      required: true,
    },
    prescriptionDate: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    maxDispensings: { type: Number, min: 1, max: 24 },   // repeat control: at most this many dispensings (unset = limited only by the quantities)
    minIntervalDays: { type: Number, min: 0, max: 365 }, // minimum days between two dispensings of this prescription
    items: { type: [itemSchema], validate: (v) => v.length > 0 },
    status: { type: String, enum: ['RECEIVED', 'VALIDATED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'REJECTED', 'CANCELLED', 'EXPIRED'], default: 'RECEIVED' },
    receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    review: { type: new Schema({ by: Schema.Types.ObjectId, at: Date, note: String, allergyChecked: Boolean }, { _id: false }) },
    interventions: { type: [new Schema({ at: Date, by: Schema.Types.ObjectId, type: { type: String, enum: ['CLARIFICATION', 'CHANGE_AUTHORISED', 'ALLERGY_ALERT', 'OTHER'] }, note: String }, { _id: false })], default: [] },
    closure: { type: new Schema({ by: Schema.Types.ObjectId, at: Date, reason: String }, { _id: false }) }, // rejection / cancellation reason
    dispensingIds: [{ type: Schema.Types.ObjectId, ref: 'DispensingRecord' }],
  },
  { timestamps: true }
);

prescriptionSchema.index({ businessId: 1, number: 1 }, { unique: true });
prescriptionSchema.index({ businessId: 1, patientId: 1, createdAt: -1 });
prescriptionSchema.index({ businessId: 1, status: 1, createdAt: -1 });

module.exports = model('Prescription', prescriptionSchema);