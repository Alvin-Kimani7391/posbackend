const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const { HANDLING, TRACKING_METHODS, BARCODE_RULES, PRODUCT_LIFECYCLE } = require('../constants/hardware');
/** Hardware facts for a Product. Price breaks are per BASE unit (integer cents). Products without a profile behave as before. */
const hardwareProfileSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  templateId: { type: Schema.Types.ObjectId, ref: 'HardwareTemplate' },
  attributes: [{ _id: false, key: String, value: Schema.Types.Mixed }],          // custom attributes from the template (diameter, grade, colour...)
  trackingMethod: { type: String, enum: TRACKING_METHODS, default: 'COUNT' },
  barcodeRule: { type: String, enum: BARCODE_RULES, default: 'OPTIONAL' },
  altBarcodes: [{ type: String, trim: true }],                                   // extra barcodes that point at this same item
  lifecycle: { type: String, enum: PRODUCT_LIFECYCLE, default: 'ACTIVE' },       // UNAVAILABLE blocks selling; DISCONTINUED lets stock sell down
  minSellingPrice: { type: Number, min: 0 },                                      // per BASE unit, cents; priceQuote flags anything below it
  maxStock: { type: Number, min: 0 }, minStock: { type: Number, min: 0 },
  preferredSupplierId: { type: Schema.Types.ObjectId, ref: 'Supplier' },
  bundle: [{ _id: false, productId: { type: Schema.Types.ObjectId, ref: 'Product' }, quantity: { type: Number, min: 0.001 } }], // kit / bundle contents (informational + pick list)
  manufacturer: { type: String, trim: true, maxlength: 80 },
  specification: { type: String, trim: true, maxlength: 300 },   // "12mm x 6m, grade 60"
  technicalNotes: { type: String, trim: true, maxlength: 1000 },
  supplierCode: { type: String, trim: true, maxlength: 60 },
  dimensions: { length: Number, width: Number, height: Number }, // cm
  weightKg: { type: Number, min: 0 },                             // per base unit
  measurable: { type: Boolean, default: false },                  // true: quantities may be fractional (cable by the metre)
  divisible: { type: Boolean, default: true },                    // false: a box of tiles is sold only in its bigger units, never loose
  handling: { type: [String], enum: HANDLING, default: [] },
  leadTimeDays: { type: Number, min: 0, max: 365 },
  compatibleIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  alternativeIds: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  breaks: [{ _id: false, minQty: { type: Number, required: true, min: 0.001 }, unitPrice: { type: Number, required: true, min: 0 } }], // quantity breaks: price per base unit from minQty (base units) up
  locations: [{ _id: false, branchId: { type: Schema.Types.ObjectId, ref: 'Branch' }, locationId: { type: Schema.Types.ObjectId, ref: 'WarehouseLocation' } }],
}, { timestamps: true });
hardwareProfileSchema.index({ businessId: 1, productId: 1 }, { unique: true });
hardwareProfileSchema.index({ businessId: 1, altBarcodes: 1 }, { unique: true, partialFilterExpression: { altBarcodes: { $type: 'string' } } });
moneyFields(hardwareProfileSchema, ['minSellingPrice'], { breaks: ['unitPrice'] });
module.exports = model('HardwareProfile', hardwareProfileSchema);
