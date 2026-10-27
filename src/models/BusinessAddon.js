const { Schema, model } = require('mongoose');
const { ADDON_STATUSES, ADDON_CURRENCIES } = require('../constants/addons');
/** One business x one add-on. Access is derived from dates (addon.entitlement.js). */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  addonKey: { type: String, required: true, lowercase: true, trim: true },
  status: { type: String, enum: ADDON_STATUSES, default: 'PENDING_PAYMENT' },
  isTrial: { type: Boolean, default: false },
  currency: { type: String, enum: ADDON_CURRENCIES, default: 'KES' },
  priceCents: { type: Number, default: 0, min: 0 },
  priceOverrideCents: { type: Number, min: 0 },
  intervalMonths: { type: Number, default: 1 },
  startedAt: { type: Date }, currentPeriodStart: { type: Date }, currentPeriodEnd: { type: Date },
  pendingInvoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice' },
  cancelAtPeriodEnd: { type: Boolean, default: false }, cancelledAt: { type: Date }, cancelReason: { type: String, maxlength: 300 },
  complimentary: { type: Boolean, default: false }, complimentaryUntil: { type: Date },
  source: { type: String, enum: ['OWNER', 'ADMIN'], default: 'OWNER' },
  history: [{ _id: false, at: Date, type: String, note: String, by: String }],
  notifiedKeys: [{ type: String }],
}, { timestamps: true });
s.index({ businessId: 1, addonKey: 1 }, { unique: true });
s.index({ status: 1, currentPeriodEnd: 1 });
s.index({ addonKey: 1, status: 1 });
module.exports = model('BusinessAddon', s);
