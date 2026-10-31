const { Schema, model } = require('mongoose');
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  quoteValidityDays: { type: Number, default: 14, min: 1, max: 365 },
  reserveOnApproval: { type: Boolean, default: true },   // approved orders hold stock
  reservationDays: { type: Number, default: 7, min: 1, max: 180 }, // ...for this long, then it is released
  lowMarginPercent: { type: Number, default: 5, min: 0, max: 100 }, // quotation lines under this margin are flagged
  freeDeliveryAbove: { type: Number, default: 0, min: 0 },     // cents: orders at or above this ship free (0 = off)
  absorbDelivery: { type: Boolean, default: false },            // business pays for delivery: charge to customer is 0, the cost still counts
  requireProofOnDelivery: { type: Boolean, default: true },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
require('../utils/moneySchemaPlugin')(schema, ['freeDeliveryAbove']);
module.exports = model('HardwareSettings', schema);
