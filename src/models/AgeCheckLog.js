const { Schema, model } = require('mongoose');
/** Every age check on an alcohol sale, passed or refused. No full ID number and no date of birth is kept: only the type, the last 4 characters and the age worked out. */
const ageCheckLogSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', index: true },
  saleId: { type: Schema.Types.ObjectId, ref: 'Sale', index: true },
  cashierId: { type: Schema.Types.ObjectId, ref: 'User' },
  outcome: { type: String, enum: ['PASSED', 'REFUSED'], required: true },
  method: { type: String, enum: ['CONFIRMED', 'ID', 'DOB'], required: true },
  idType: { type: String }, idLast4: { type: String, maxlength: 4 }, ageYears: { type: Number },
  reason: { type: String, trim: true },
  at: { type: Date, default: Date.now },
}, { timestamps: false });
ageCheckLogSchema.index({ businessId: 1, at: -1 });
module.exports = model('AgeCheckLog', ageCheckLogSchema);
