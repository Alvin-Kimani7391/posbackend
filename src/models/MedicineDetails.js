const { Schema, model } = require('mongoose');

/**
 * Medicine master data for a Product (one record per product). The Product keeps price, cost, stock and tax; this keeps what
 * makes it a medicine: what it is, how strong, what form, how it is classified and stored.
 * `classification` is a code from the business's configured classes (Business.pharmacySettings.classes), so the owner and
 * their pharmacist set the rules to match the current PPB schedules - nothing is hard-coded here.
 */
const medicineDetailsSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    brandName: { type: String, trim: true },
    genericName: { type: String, required: true, trim: true },      // active ingredient(s)
    strength: { type: String, required: true, trim: true },         // "500 mg", "125 mg/5 ml"
    dosageForm: { type: String, required: true, trim: true, lowercase: true }, // tablet, capsule, syrup, cream, injection...
    packSize: { type: String, trim: true },                         // "10 x 10 tablets"
    manufacturer: { type: String, trim: true },
    registrationNumber: { type: String, trim: true },               // PPB registration / authorisation, as applicable
    supplierCode: { type: String, trim: true },
    classification: { type: String, default: 'OTC', trim: true, uppercase: true },
    storage: {
      type: new Schema({ instructions: String, minC: Number, maxC: Number, coldChain: { type: Boolean, default: false } }, { _id: false }),
      default: undefined,
    },
    unitOfSale: { type: String, trim: true },                       // tablet, strip, bottle
    infoReference: { type: String, trim: true },                    // link or reference to the product information leaflet
    alternatives: [{ type: Schema.Types.ObjectId, ref: 'Product' }], // pharmacist-curated alternatives (never auto-suggested as a substitute)
    status: { type: String, enum: ['active', 'discontinued', 'recalled', 'quarantined'], default: 'active' },
    statusReason: String,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

medicineDetailsSchema.index({ businessId: 1, productId: 1 }, { unique: true });
medicineDetailsSchema.index({ businessId: 1, genericName: 1, strength: 1, dosageForm: 1 });
medicineDetailsSchema.index({ businessId: 1, classification: 1 });
medicineDetailsSchema.index({ businessId: 1, brandName: 'text', genericName: 'text' });

module.exports = model('MedicineDetails', medicineDetailsSchema);