const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { HELD_TTL_HOURS } = require('../constants/shop');

/** A parked cart. Nothing is reserved and nothing is priced as final: the sale is re-priced from the server when it is recalled and paid. */
const heldItem = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
  unitId: { type: Schema.Types.ObjectId },
  nameSnapshot: { type: String },
  quantity: { type: Number, required: true, min: 0.001 },
  discount: { type: Number, default: 0, min: 0 }, // integer cents, line discount the cashier had set
  note: { type: String, trim: true, maxlength: 120 },
}, { _id: false });

const heldSaleSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  cashierId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  label: { type: String, trim: true, maxlength: 60 }, // "Blue shirt lady", "Table 3"
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
  items: { type: [heldItem], validate: (v) => v.length > 0 },
  cartDiscount: { type: Number, default: 0, min: 0 },
  notes: { type: String, trim: true, maxlength: 300 },
  status: { type: String, enum: ['HELD', 'RECALLED', 'DISCARDED'], default: 'HELD', index: true },
  recalledAt: { type: Date },
  discardedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  expiresAt: { type: Date, default: () => new Date(Date.now() + HELD_TTL_HOURS * 3600 * 1000) },
}, { timestamps: true });

heldSaleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Mongo removes expired parked carts by itself
heldSaleSchema.index({ businessId: 1, branchId: 1, status: 1, createdAt: -1 });
moneyFields(heldSaleSchema, ['cartDiscount'], { items: ['discount'] });
module.exports = model('HeldSale', heldSaleSchema);
