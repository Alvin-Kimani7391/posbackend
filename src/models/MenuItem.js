const { Schema, model } = require('mongoose');
const { ALLERGENS, STOCK_MODES } = require('../constants/restaurant');
const moneyPaths = require('../utils/moneyDeepPlugin');
const window = { _id: false, days: [Number], start: String, end: String, startDate: Date, endDate: Date };
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },   // the backing Product: invoices, eTIMS, CRM and reports all see it
  ownsProduct: { type: Boolean, default: true },                                  // false = linked to an existing stocked product (stockMode PRODUCT)
  categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },
  name: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  image: { type: String },
  basePrice: { type: Number, required: true, min: 0 },                           // integer cents
  typePrices: { dineIn: Number, takeaway: Number, delivery: Number },            // integer cents, optional per service mode
  branchOverrides: [{ _id: false, branchId: { type: Schema.Types.ObjectId, ref: 'Branch' }, price: Number, available: { type: Boolean, default: true } }],
  variants: [{ name: { type: String, required: true }, price: Number, priceDelta: { type: Number, default: 0 }, portionMultiplier: { type: Number, default: 1, min: 0.01 }, active: { type: Boolean, default: true } }],
  requireVariant: { type: Boolean, default: false },
  modifierGroupIds: [{ type: Schema.Types.ObjectId, ref: 'ModifierGroup' }],
  timedPrices: [{ _id: false, label: String, windows: [window], price: Number, percentOff: Number, branchIds: [{ type: Schema.Types.ObjectId, ref: 'Branch' }] }], // happy hour / promotions
  menuPeriods: [window],                                                          // breakfast / lunch / dinner availability
  taxRate: { type: Number, default: 0, min: 0, max: 100 },
  serviceChargeable: { type: Boolean, default: true },
  prepMinutes: { type: Number, default: 10, min: 0 },
  stationCode: { type: String, trim: true, uppercase: true, default: 'KITCHEN' },
  allergens: [{ type: String, enum: ALLERGENS }],
  stockMode: { type: String, enum: STOCK_MODES, default: 'NONE' },               // NONE (no stock), RECIPE (ingredients), PRODUCT (a stocked product, e.g. bottled soda)
  costCents: { type: Number, default: 0 },                                        // current estimated cost per portion, refreshed from the recipe
  isCombo: { type: Boolean, default: false },
  comboGroups: [{ name: { type: String, required: true }, min: { type: Number, default: 1 }, max: { type: Number, default: 1 }, options: [{ _id: false, menuItemId: { type: Schema.Types.ObjectId, ref: 'MenuItem' }, priceDelta: { type: Number, default: 0 } }] }],
  soldOut: { flag: { type: Boolean, default: false }, reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date },
  sortOrder: { type: Number, default: 0 },
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
s.index({ businessId: 1, name: 1 });
s.index({ businessId: 1, categoryId: 1, status: 1 });
s.index({ businessId: 1, productId: 1 });
moneyPaths(s, ['basePrice', 'typePrices.dineIn', 'typePrices.takeaway', 'typePrices.delivery', 'branchOverrides.price', 'variants.price', 'variants.priceDelta', 'timedPrices.price', 'costCents', 'comboGroups.options.priceDelta']);
module.exports = model('MenuItem', s);
