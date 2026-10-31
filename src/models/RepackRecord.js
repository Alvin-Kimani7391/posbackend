const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
/** Breaking a bulk item into a different sellable product (a bag of nails into 1 kg packets). Cost moves with the stock, nothing is invented. */
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  sourceProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true }, sourceQty: { type: Number, required: true },
  targetProductId: { type: Schema.Types.ObjectId, ref: 'Product', required: true }, targetQty: { type: Number, required: true },
  wastageQty: { type: Number, default: 0 }, costMoved: { type: Number, default: 0 },
  note: { type: String, trim: true, maxlength: 200 },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
moneyFields(schema, ['costMoved']);
module.exports = model('RepackRecord', schema);
