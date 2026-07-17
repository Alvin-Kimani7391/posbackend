const mongoose = require('mongoose');

const saleItemSchema = new mongoose.Schema(
  {
    medication_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medication' },
    name: { type: String, required: true },
    barcode: { type: String },
    quantity: { type: Number, required: true },
    unit_price: { type: Number, required: true },
    total: { type: Number, required: true },
  },
  { _id: true }
);

const saleSchema = new mongoose.Schema(
  {
    invoice_number: { type: String, required: true, unique: true },
    patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    worker_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Worker', required: true },
    subtotal: { type: Number, required: true },
    tax_rate: { type: Number, default: 0 },
    tax_amount: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true },
    payment_method: { type: String, enum: ['cash', 'card', 'mobile', 'insurance'], default: 'cash' },
    payment_status: { type: String, enum: ['paid', 'pending', 'refunded'], default: 'paid' },
    sale_items: [saleItemSchema],
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('Sale', saleSchema);
