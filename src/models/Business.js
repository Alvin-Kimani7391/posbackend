const { Schema, model } = require('mongoose');

const { BUSINESS_TYPES, FEATURE_KEYS } = require('../constants/businessFeatures');

const featureSettingsSchema = new Schema(
  Object.fromEntries(FEATURE_KEYS.map((k) => [k, { type: Boolean, default: false }])),
  { _id: false }
);

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, trim: true },
    businessType: { type: String, enum: BUSINESS_TYPES, default: 'general_shop' },
    businessSubtype: { type: String, trim: true, maxlength: 60 }, // e.g. mini-supermarket, cafe
    featureSettings: { type: featureSettingsSchema, default: () => ({}) },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    county: { type: String, trim: true },
    town: { type: String, trim: true },
    country: { type: String, default: 'Kenya' },
    taxPin: { type: String, trim: true },
    kraPin: { type: String, trim: true },
    vatRegistered: { type: Boolean, default: false },
    currency: { type: String, default: 'KES' },
    timezone: { type: String, default: 'Africa/Nairobi' },
    logo: { type: String },

    receiptSettings: {
      footerMessage: { type: String, default: 'Thank you for your business!' },
      headerMessage: { type: String, default: '' },
      showLogo: { type: Boolean, default: true },
      showKraPin: { type: Boolean, default: true },
      showCashierName: { type: Boolean, default: true },
      showMpesaReceiptCode: { type: Boolean, default: true },
      receiptPrefix: { type: String, default: 'RCT' },
      invoicePrefix: { type: String, default: 'INV' },
      paperWidth: { type: String, enum: ['58mm', '80mm'], default: '80mm' },
      customLines: [{ type: String }], // free-form extra lines, e.g. "Returns within 7 days only"
    },

    taxSettings: {
      taxInclusive: { type: Boolean, default: true },
      defaultTaxRate: { type: Number, default: 16 },
    },

    paymentSettings: {
      acceptCash: { type: Boolean, default: true },
      acceptMpesa: { type: Boolean, default: true },
      acceptCard: { type: Boolean, default: false },
      acceptBank: { type: Boolean, default: false },
      acceptCredit: { type: Boolean, default: false },
    },

    settings: {
      allowNegativeStock: { type: Boolean, default: false },
      requireManagerRefundApproval: { type: Boolean, default: true },
      cashierPriceOverride: { type: Boolean, default: false },
      maxCashierDiscountPercent: { type: Number, default: 5 },
      maxManagerDiscountPercent: { type: Number, default: 20 },
      enableCustomerCredit: { type: Boolean, default: false },
      enableLoyalty: { type: Boolean, default: false },
      enableOfflineMode: { type: Boolean, default: true },
      requireShift: { type: Boolean, default: true },
      enableSMSReceipts: { type: Boolean, default: false },
      enableWhatsAppReceipts: { type: Boolean, default: false },
      enableEmailReceipts: { type: Boolean, default: false },

            offline: {
        enabled: { type: Boolean, default: false },
        maxOfflineHours: { type: Number, default: 12, min: 1, max: 72 },
        sessionHours: { type: Number, default: 12, min: 1, max: 24 },
        maxPendingSales: { type: Number, default: 200, min: 1, max: 5000 },
        maxPendingValueCents: { type: Number, default: 20000000, min: 0 },
        allowCredit: { type: Boolean, default: false },
        allowManualMpesa: { type: Boolean, default: false },
        allowCard: { type: Boolean, default: false },
        allowRefunds: { type: Boolean, default: false },
        maxDiscountPercent: { type: Number, default: 5, min: 0, max: 100 },
        allowShiftCloseWithPending: { type: Boolean, default: false },
        sharedDeviceMaxOfflineHours: { type: Number, default: 4, min: 1, max: 72 },
        defaultDeviceMode: { type: String, enum: ['DEDICATED', 'SHARED'], default: 'DEDICATED' },

                syncCustomers: { type: Boolean, default: false },


                manualMpesaApproval: { type: String, enum: ['UNMATCHED_ONLY', 'ALWAYS'], default: 'UNMATCHED_ONLY' },
        maxManualMpesaCents: { type: Number, default: 5000000, min: 0 },

        
      },

    },

    subscriptionPlan: { type: String, default: 'trial' },
    subscriptionStatus: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'suspended', 'cancelled'],
      default: 'trialing',
    },
    subscriptionExpiresAt: { type: Date },

    status: { type: String, enum: ['active', 'suspended', 'closed'], default: 'active' },
  },
  { timestamps: true }
);

businessSchema.index({ name: 1 });
businessSchema.index({ kraPin: 1 });

module.exports = model('Business', businessSchema);
module.exports.BUSINESS_TYPES = BUSINESS_TYPES;