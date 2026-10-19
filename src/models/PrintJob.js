const { Schema, model } = require('mongoose');
/** Paper waiting for a printer: kitchen / bar tickets and paid receipts. A staff device set to "auto-print" collects and prints them. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  target: { type: String, enum: ['KITCHEN', 'BAR', 'CASHIER'], required: true },
  kind: { type: String, enum: ['KOT', 'RECEIPT'], required: true },
  title: String, doc: Schema.Types.Mixed,
  refId: Schema.Types.ObjectId,
  status: { type: String, enum: ['PENDING', 'CLAIMED', 'PRINTED'], default: 'PENDING' },
  claimedAt: Date, printedAt: Date, copies: { type: Number, default: 1 },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 3 * 86400000), index: { expires: 0 } },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, target: 1, status: 1, createdAt: 1 });
module.exports = model('PrintJob', s);
