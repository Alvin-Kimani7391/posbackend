const { Schema, model } = require('mongoose');
const { AREA_TYPES } = require('../constants/restaurant');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  type: { type: String, enum: AREA_TYPES, default: 'INDOOR' },
  sortOrder: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, name: 1 }, { unique: true });
module.exports = model('RestaurantArea', s);
