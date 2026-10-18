const { Schema, model } = require('mongoose');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true },          // menu items route by this code (GRILL, BAR, FRYER...)
  type: { type: String, enum: ['KITCHEN', 'BAR'], default: 'KITCHEN' },          // BAR stations consume from the bar stock location
  isDefault: { type: Boolean, default: false },                                  // catches items whose station code is not set up at this branch
  printerName: { type: String, trim: true },                                     // printer fallback when there is no screen
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, code: 1 }, { unique: true });
module.exports = model('KitchenStation', s);
