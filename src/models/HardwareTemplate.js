const { Schema, model } = require('mongoose');
const { ATTR_TYPES, TRACKING_METHODS } = require('../constants/hardware');
/** Owner-defined product template: the attributes a kind of product carries (diameter, grade, colour...) plus tracking defaults. No developer needed to add one. */
const attr = new Schema({ key: { type: String, required: true, trim: true, lowercase: true, maxlength: 30 }, label: { type: String, required: true, trim: true, maxlength: 40 }, type: { type: String, enum: ATTR_TYPES, default: 'TEXT' }, options: [String], unit: { type: String, maxlength: 12 }, required: { type: Boolean, default: false }, variantAxis: { type: Boolean, default: false } }, { _id: false });
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 60 },
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
  trackingMethod: { type: String, enum: TRACKING_METHODS, default: 'COUNT' },
  measurable: { type: Boolean, default: false }, divisible: { type: Boolean, default: true },
  suggestedBaseUnit: { type: String, maxlength: 20 }, suggestedUnits: [{ _id: false, name: String, factor: Number }],
  attributes: { type: [attr], default: [] },
  active: { type: Boolean, default: true },
}, { timestamps: true });
schema.index({ businessId: 1, name: 1 }, { unique: true });
module.exports = model('HardwareTemplate', schema);
