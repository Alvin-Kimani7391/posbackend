const { Schema, model } = require('mongoose');
/** Where stock sits: rack / shelf / bin. Code is what gets printed on the shelf, e.g. A-03-2. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
  code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
  rack: { type: String, trim: true, maxlength: 20 }, shelf: { type: String, trim: true, maxlength: 20 }, bin: { type: String, trim: true, maxlength: 20 },
  description: { type: String, trim: true, maxlength: 120 },
  active: { type: Boolean, default: true },
}, { timestamps: true });
schema.index({ businessId: 1, branchId: 1, code: 1 }, { unique: true });
module.exports = model('WarehouseLocation', schema);
