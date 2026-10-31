const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
/** Bill of quantities for a project: what the job needs, compared later with what was ordered / invoiced. baseQuantity is in the product's base unit. */
const line = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product' },
  description: { type: String, required: true, trim: true, maxlength: 160 },
  unitName: { type: String, trim: true, maxlength: 30 },
  quantity: { type: Number, required: true, min: 0.001 },
  baseQuantity: { type: Number, min: 0 },
  estUnitCost: { type: Number, default: 0, min: 0 },   // per BASE unit, cents
  estUnitPrice: { type: Number, default: 0, min: 0 },  // per BASE unit, cents
});
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
  lines: { type: [line], default: [] },
  version: { type: Number, default: 1 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
schema.index({ businessId: 1, projectId: 1 }, { unique: true });
moneyFields(schema, [], { lines: ['estUnitCost', 'estUnitPrice'] });
module.exports = model('Boq', schema);
