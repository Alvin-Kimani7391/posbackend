const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    date_of_birth: { type: Date },
    gender: { type: String, enum: ['male', 'female', 'other'], default: 'male' },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    medical_record_number: { type: String, trim: true },
    allergies: { type: String, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

patientSchema.index({ name: 'text', medical_record_number: 'text', phone: 'text' });

module.exports = mongoose.model('Patient', patientSchema);
