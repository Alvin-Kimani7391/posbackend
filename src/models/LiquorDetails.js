const { Schema, model } = require('mongoose');
const { CATEGORIES, ALCOHOL_CATEGORIES } = require('../constants/liquor');

/** Liquor facts about a Product. Prices, stock, batches and units stay on the Product (so cases, crates and bottles use the normal unit conversions). */
const liquorDetailsSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  category: { type: String, enum: CATEGORIES, default: 'OTHER_SPIRIT' },
  isAlcohol: { type: Boolean, default: true }, // false for mixers, soft drinks, snacks: no age check, no licence rules
  abv: { type: Number, min: 0, max: 100 },     // % alcohol by volume
  volumeMl: { type: Number, min: 1 },          // of ONE bottle / can
  vintage: { type: Number, min: 1800, max: 2100 },
  country: { type: String, trim: true }, region: { type: String, trim: true }, producer: { type: String, trim: true },
  exciseCentsPerUnit: { type: Number, min: 0 }, // optional: excise already inside the shelf price, per base unit (for the excise report)
  // returnable packaging: selling this product sends `containersPerUnit` containers out with the customer
  containerTypeId: { type: Schema.Types.ObjectId, ref: 'ContainerType' },
  containersPerUnit: { type: Number, default: 1, min: 0 },
  // a TOT product: selling it draws `ml` from an open bottle of `bottleProductId`
  tot: { bottleProductId: { type: Schema.Types.ObjectId, ref: 'Product' }, ml: { type: Number, min: 1 } },
}, { timestamps: true });
liquorDetailsSchema.index({ businessId: 1, productId: 1 }, { unique: true });
liquorDetailsSchema.index({ businessId: 1, category: 1 });
liquorDetailsSchema.pre('validate', function check(next) {
  if (this.isModified('category') && !this.isModified('isAlcohol') && this.isNew) this.isAlcohol = ALCOHOL_CATEGORIES.includes(this.category);
  if (this.isAlcohol && this.abv == null) return next(new Error('ABV is required for an alcoholic product'));
  if (this.tot && this.tot.bottleProductId && !(this.tot.ml > 0)) return next(new Error('Tot size (ml) is required'));
  return next();
});
module.exports = model('LiquorDetails', liquorDetailsSchema);
