const { Schema, model } = require('mongoose');
const { ADDON_KEY_RE, ADDON_CURRENCIES, ADDON_BILLING_TYPES } = require('../constants/addons');
const { BUSINESS_TYPES } = require('../constants/businessFeatures');
/** Add-on CATALOGUE (platform level). isActive = on sale AND enforced; while false the feature stays free. businessTypes empty = all types. */
const priceSchema = new Schema({ currency: { type: String, enum: ADDON_CURRENCIES, required: true }, amountCents: { type: Number, required: true, min: 0 } }, { _id: false });
const s = new Schema({
  key: { type: String, required: true, unique: true, trim: true, lowercase: true, match: ADDON_KEY_RE },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  tagline: { type: String, trim: true, default: '', maxlength: 200 },
  description: { type: String, trim: true, default: '', maxlength: 1500 },
  benefits: [{ type: String, trim: true, maxlength: 140 }],
  icon: { type: String, trim: true, default: 'star', maxlength: 30 },
  businessTypes: [{ type: String, enum: BUSINESS_TYPES }],
  pages: [{ type: String, trim: true, maxlength: 80 }],
  prices: { type: [priceSchema], default: [] },
  billingType: { type: String, enum: ADDON_BILLING_TYPES, default: 'RECURRING' }, // subscription or one-time purchase
  intervalMonths: { type: Number, default: 1, min: 1, max: 24 },
  trialDays: { type: Number, default: 0, min: 0, max: 90 },
  graceDays: { type: Number, default: 3, min: 0, max: 30 },
  isActive: { type: Boolean, default: false },
  sortOrder: { type: Number, default: 100 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
s.index({ isActive: 1, sortOrder: 1 });
module.exports = model('BillingAddon', s);
