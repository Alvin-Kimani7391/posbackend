const mongoose = require('mongoose');

const prescriptionSchema = new mongoose.Schema(
  {
    patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    medication_name: { type: String, required: true, trim: true },
    dosage: { type: String, trim: true },
    frequency: { type: String, trim: true },
    duration: { type: String, trim: true },
    prescribed_by: { type: String, trim: true },
    status: { type: String, enum: ['pending', 'dispensed', 'cancelled'], default: 'pending' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('Prescription', prescriptionSchema);
