const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { QUOTE_STATUSES } = require('../constants/hardware');
/** A quotation. Once APPROVED it is the sales order: it can reserve stock and be invoiced in parts (partial fulfilment, backorder). Money = integer cents. */
const line = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
  unitId: { type: Schema.Types.ObjectId }, unitName: String, unitFactor: { type: Number, default: 1 },
  nameSnapshot: { type: String, required: true }, skuSnapshot: String,
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true, min: 0 },           // per SOLD unit
  costSnapshot: { type: Number, default: 0 },                     // per SOLD unit, for margin
  discount: { type: Number, default: 0 },                         // line total discount
  taxRate: { type: Number, default: 0 },
  lineTotal: { type: Number, required: true },
  fulfilledQty: { type: Number, default: 0 },
  reservedBase: { type: Number, default: 0 },                     // base units currently held for this line
}, { _id: true });
const schema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  number: { type: String, required: true },
  status: { type: String, enum: QUOTE_STATUSES, default: 'DRAFT' },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
  customerPO: { type: String, trim: true, maxlength: 60 },
  reference: { type: String, trim: true, maxlength: 80 },
  validUntil: { type: Date, required: true },
  items: { type: [line], validate: (v) => v.length > 0 },
  subtotal: { type: Number, default: 0 }, discountTotal: { type: Number, default: 0 }, total: { type: Number, default: 0 },
  deliveryCharge: { type: Number, default: 0 },                   // quoted for the customer; billed on the delivery order, not part of `total`
  deliveryAddress: { type: String, trim: true, maxlength: 250 },
  notes: { type: String, trim: true, maxlength: 500 }, terms: { type: String, trim: true, maxlength: 500 },
  reserve: { type: Boolean, default: true },
  reservedUntil: { type: Date },
  lowMarginLines: { type: [Number], default: [] },
  priceLockedAt: { type: Date },
  approvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, approvedAt: Date,
  rejectedReason: String,
  fulfilments: [{ _id: false, saleId: { type: Schema.Types.ObjectId, ref: 'Sale' }, at: Date, total: Number, repriced: Boolean, lines: [{ _id: false, lineId: Schema.Types.ObjectId, quantity: Number }] }],
  history: [{ _id: false, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, action: String, note: String }],
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true });
schema.index({ businessId: 1, number: 1 }, { unique: true });
schema.index({ businessId: 1, status: 1, validUntil: 1 });
schema.index({ businessId: 1, customerId: 1, createdAt: -1 });
moneyFields(schema, ['subtotal', 'discountTotal', 'total', 'deliveryCharge'], { items: ['unitPrice', 'costSnapshot', 'discount', 'lineTotal'], fulfilments: ['total'] });
module.exports = model('Quotation', schema);
