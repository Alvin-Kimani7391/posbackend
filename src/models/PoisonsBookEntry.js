const { Schema, model } = require('mongoose');

/**
 * The Poisons Book. Kenya's Pharmacy and Poisons Act (s.30) requires an entry before a Part I poison is sold over the counter
 * without a prescription: date, purchaser's name and address, the poison and quantity, the stated purpose, and the purchaser's signature.
 * Append-only: written inside the sale, never edited.
 */
const poisonsBookEntrySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    number: { type: String, required: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', required: true, index: true },
    items: [{
      _id: false, productId: Schema.Types.ObjectId, nameSnapshot: String, strength: String, dosageForm: String, quantity: Number,
      batches: [{ _id: false, batchId: Schema.Types.ObjectId, batchNumber: String, quantity: Number }],
    }],
    purchaser: { type: new Schema({ name: { type: String, required: true }, address: { type: String, required: true }, idNumber: String, purpose: { type: String, required: true }, signed: { type: Boolean, required: true } }, { _id: false }), required: true },
    dispenserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dispenserSnapshot: { type: new Schema({ name: String, role: String, registrationNumber: String }, { _id: false }) },
  },
  { timestamps: true }
);
poisonsBookEntrySchema.index({ businessId: 1, number: 1 }, { unique: true });
poisonsBookEntrySchema.index({ businessId: 1, createdAt: -1 });
poisonsBookEntrySchema.pre(['updateOne', 'findOneAndUpdate', 'updateMany', 'deleteOne', 'findOneAndDelete', 'deleteMany'], function block(next) { next(new Error('Poisons Book entries cannot be changed or deleted')); });

module.exports = model('PoisonsBookEntry', poisonsBookEntrySchema);