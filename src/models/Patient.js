const { Schema, model } = require('mongoose');

/**
 * A patient is NOT a marketing contact: it is deliberately separate from Customer so CRM, SMS campaigns and ordinary
 * sales reports never see it. Hold only what the workflow needs. Every read of a patient record is audit-logged.
 */
const patientSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    number: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    idType: { type: String, enum: ['NATIONAL_ID', 'PASSPORT', 'BIRTH_CERT', 'OTHER'] },
    idNumber: { type: String, trim: true },
    dateOfBirth: Date,
    sex: { type: String, enum: ['F', 'M', 'OTHER'] },
    allergies: { type: [String], default: [] },          // only where the patient chose to tell us
    notes: { type: String, trim: true },                 // minimum necessary
    consent: {
      type: new Schema({ given: Boolean, at: Date, basis: { type: String, trim: true }, recordedBy: Schema.Types.ObjectId }, { _id: false }),
      default: undefined,
    },
    status: { type: String, enum: ['active', 'erased'], default: 'active' }, // erased = personal data removed, history shell kept
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

patientSchema.index({ businessId: 1, number: 1 }, { unique: true });
patientSchema.index({ businessId: 1, name: 1 });
patientSchema.index({ businessId: 1, phone: 1 }, { sparse: true });
patientSchema.index({ businessId: 1, idNumber: 1 }, { sparse: true });

module.exports = model('Patient', patientSchema);