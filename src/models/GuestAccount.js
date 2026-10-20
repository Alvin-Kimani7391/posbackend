const { Schema, model } = require('mongoose');
/** A customer's own account on one business's QR page: keeps their orders and electronic receipts. Register by hand or with Google. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },                                // digits only, 2547XXXXXXXX
  passwordHash: { type: String, select: false },
  googleSub: { type: String },
  picture: String,
  lastLoginAt: Date,
}, { timestamps: true });
s.index({ businessId: 1, email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
s.index({ businessId: 1, phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
s.index({ businessId: 1, googleSub: 1 }, { unique: true, partialFilterExpression: { googleSub: { $type: 'string' } } });
module.exports = model('GuestAccount', s);
