const { Schema, model } = require('mongoose');

const branchSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    county: { type: String, trim: true },
    town: { type: String, trim: true },
    managerId: { type: Schema.Types.ObjectId, ref: 'User' },

    receiptSettings: {
      footerMessage: { type: String },
      receiptPrefix: { type: String },
    },

    isMainBranch: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
  },
  { timestamps: true }
);

branchSchema.index({ businessId: 1, code: 1 }, { unique: true });

module.exports = model('Branch', branchSchema);
