const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const PRODUCT_TYPES = ['physical', 'service', 'weighted', 'digital'];
// RETAIL_FIRST  = classic shop: sellingPrice is the main price, wholesale is an optional MOQ discount.
// WHOLESALE_FIRST = wholesaler: the WHOLESALE unit price is the main price; retail (and unit conversion) is optional.
const PRICING_MODES = ['RETAIL_FIRST', 'WHOLESALE_FIRST'];
const UNITS = [
  'piece', 'kg', 'g', 'litre', 'ml', 'metre', 'box', 'packet', 'service',
  'bundle', 'carton', 'dozen', 'pack', 'bag', 'sack', 'bottle', 'tin', 'sachet', 'roll', 'pair', 'set', 'tray', 'crate', 'pallet', 'tablet', 'strip',
];

// Other ways to buy / move / sell the same stock (utils/units.js). Stock is ALWAYS kept in the base unit (Product.unit);
// factor = BASE units in one of these. Prices are for ONE such unit (integer cents).
const productUnitSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 30 }, // bundle, carton, dozen, 2kg bag...
  code: { type: String, trim: true, maxlength: 12 },
  factor: { type: Number, required: true, min: 0.001 },
  barcode: { type: String, trim: true },
  wholesalePrice: { type: Number, min: 0 }, // price of one such unit in the WHOLESALE sale mode
  retailPrice: { type: Number, min: 0 },    // price of one such unit in the RETAIL sale mode
  isWholesaleDefault: { type: Boolean, default: false },
  status: { type: String, enum: ['active', 'inactive'], default: 'active' },
});

const productSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category' },

    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true, uppercase: true },
    barcode: { type: String, trim: true },
    description: { type: String, trim: true },
    brand: { type: String, trim: true },

    productType: { type: String, enum: PRODUCT_TYPES, default: 'physical' },

    // How this product is priced/entered (see PRICING_MODES). retailEnabled=false (WHOLESALE_FIRST only) = sold in
    // wholesale only: the retail till and warehouse -> shop-floor moves refuse it.
    pricingMode: { type: String, enum: PRICING_MODES, default: 'RETAIL_FIRST' },
    retailEnabled: { type: Boolean, default: true },

    // --- money fields: stored as integer CENTS, see moneySchemaPlugin ---
    costPrice: { type: Number, required: true, default: 0, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    // WHOLESALE (rule lives in utils/wholesale.js). wholesalePrice = per-unit price (cents) once a sale holds >= moq.
    // wholesaleEnabled=false (default) keeps the product retail-only; any old wholesalePrice stays dormant.
    wholesalePrice: { type: Number, min: 0 },
    wholesaleEnabled: { type: Boolean, default: false },
    moq: { type: Number, min: 0 }, // minimum order quantity, in this product's unit (fractional allowed)

    // Standing discount PER UNIT (integer cents). The POS pre-fills a sale
    // line with (defaultDiscount x quantity) when this product is scanned or
    // searched. 0 = no standing discount. For products with variants it is
    // applied to every variant (and clamped to the line total at sale time).
    defaultDiscount: { type: Number, default: 0, min: 0 },

    taxRate: { type: Number, default: 0, min: 0, max: 100 }, // percent
    taxCategory: { type: String, default: 'standard' }, // e.g. standard, zero-rated, exempt

    unit: { type: String, enum: UNITS, default: 'piece' }, // BASE unit: stock, batches and the ledger are counted in it
    units: { type: [productUnitSchema], default: [] },     // bigger/other units that convert to the base unit (feature: unitConversions)

    trackInventory: { type: Boolean, default: true },
    trackSerialNumber: { type: Boolean, default: false },
    serialKind: { type: String, enum: ['serial', 'imei'], default: 'serial' }, // imei = 15-digit Luhn-checked
    warrantyMonths: { type: Number, default: 0, min: 0, max: 120 },          // shop warranty given to the customer
    supplierWarrantyMonths: { type: Number, default: 0, min: 0, max: 120 },  // warranty the supplier gives the shop
    trackBatch: { type: Boolean, default: false },
    trackExpiry: { type: Boolean, default: false },

    lowStockThreshold: { type: Number, default: 5, min: 0 },

    hasVariants: { type: Boolean, default: false },

    // --- eTIMS (DigiTax) registration tracking - see integrations/etims ---
    etims: {
      itemId: { type: String }, // DigiTax's item_id once registered
      status: { type: String, enum: ['UNREGISTERED', 'PENDING', 'REGISTERED', 'FAILED'], default: 'UNREGISTERED' },
      lastError: { type: String },
    },

    image: { type: String },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

productSchema.index({ businessId: 1, sku: 1 }, { unique: true });
productSchema.index({ businessId: 1, barcode: 1 }, { unique: true, sparse: true });
productSchema.index({ businessId: 1, name: 'text', brand: 'text' });
productSchema.index({ businessId: 1, categoryId: 1 });
productSchema.index({ businessId: 1, status: 1 });

// Safety net: validators/service return a clear 400 first; this stops any other code path saving an unusable set-up.
productSchema.pre('validate', function enforceWholesaleConfig(next) {
  if (!this.wholesaleEnabled) return next();
  if (!(this.moq > 0)) return next(new Error('MOQ is required when wholesale is enabled'));
  if (!this.hasVariants && !(this.wholesalePrice > 0)) return next(new Error('Wholesale price is required when wholesale is enabled'));
  return next();
});

moneyFields(productSchema, ['costPrice', 'sellingPrice', 'wholesalePrice', 'defaultDiscount'], { units: ['wholesalePrice', 'retailPrice'] });

module.exports = model('Product', productSchema);
module.exports.PRODUCT_TYPES = PRODUCT_TYPES;
module.exports.UNITS = UNITS;
module.exports.PRICING_MODES = PRICING_MODES;