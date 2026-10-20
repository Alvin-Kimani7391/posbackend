const { Schema, model } = require('mongoose');
/** The electronic copy of a bill a guest paid from the QR page. An unchanging snapshot, so it stays correct whatever happens to the bill later. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'GuestAccount', index: true },
  reference: { type: String, required: true },                        // the M-PESA request reference: the guest's key to this receipt
  placeKey: String, kind: { type: String, enum: ['BILL', 'STAY'] },
  number: String, total: Number, paidAmount: Number, paid: Boolean,
  snapshot: Schema.Types.Mixed,
}, { timestamps: true });
s.index({ businessId: 1, reference: 1 }, { unique: true });
s.index({ businessId: 1, accountId: 1, createdAt: -1 });
module.exports = model('GuestReceipt', s);
