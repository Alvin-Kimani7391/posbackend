const { Schema, model } = require('mongoose');

const cashRegisterSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

cashRegisterSchema.index({ businessId: 1, branchId: 1, code: 1 }, { unique: true });

module.exports = model('CashRegister', cashRegisterSchema);
