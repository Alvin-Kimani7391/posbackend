const mongoose = require('mongoose');

const medicationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    generic_name: { type: String, trim: true },
    barcode: { type: String, trim: true, index: true },
    category: { type: String, trim: true },
    form: {
      type: String,
      enum: ['tablet', 'capsule', 'syrup', 'injection', 'ointment', 'drops', 'inhaler', 'other'],
      default: 'tablet',
    },
    strength: { type: String, trim: true },
    unit: { type: String, trim: true, default: 'piece' },
    price: { type: Number, required: true, default: 0 },
    cost_price: { type: Number, default: 0 },
    stock_quantity: { type: Number, default: 0 },
    reorder_level: { type: Number, default: 10 },
    expiry_date: { type: Date },
    batch_number: { type: String, trim: true },
    manufacturer: { type: String, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

medicationSchema.index({ name: 'text', generic_name: 'text', category: 'text' });

module.exports = mongoose.model('Medication', medicationSchema);
