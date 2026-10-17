const { Schema, model } = require('mongoose');

const { BUSINESS_TYPES, FEATURE_KEYS } = require('../constants/businessFeatures');
const { ONBOARDING_STEP_KEYS, ONBOARDING_STEP_STATUSES } = require('../constants/onboarding');
const { COUNTRY_CODES, LANGUAGES, getCountry } = require('../constants/countries');

const featureSettingsSchema = new Schema(
  Object.fromEntries(FEATURE_KEYS.map((k) => [k, { type: Boolean, default: false }])),
  { _id: false }
);

// Setup guide progress. Only the owner's MANUAL choices are stored (steps that can be detected
// from real data are detected by the frontend). Existing businesses have typeConfirmed=false,
// which is what makes the app offer the "choose your business type" pop-up once.
const onboardingSchema = new Schema(
  {
    typeConfirmed: { type: Boolean, default: false },
    typeConfirmedAt: { type: Date },
    typePromptSnoozedUntil: { type: Date },
    steps: {
      type: [new Schema(
        {
          key: { type: String, enum: ONBOARDING_STEP_KEYS, required: true },
          status: { type: String, enum: ONBOARDING_STEP_STATUSES, required: true },
          at: { type: Date, default: Date.now },
        },
        { _id: false }
      )],
      default: [],
    },
    dismissedAt: { type: Date },   // owner chose "leave the guide, I will resume later"
    completedAt: { type: Date },
  },
  { _id: false }
);

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    legalName: { type: String, trim: true },
    businessType: { type: String, enum: BUSINESS_TYPES, default: 'general_shop' },
    businessSubtype: { type: String, trim: true, maxlength: 60 }, // e.g. mini-supermarket, cafe
    featureSettings: { type: featureSettingsSchema, default: () => ({}) },
    onboarding: { type: onboardingSchema, default: () => ({}) },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    county: { type: String, trim: true },
    town: { type: String, trim: true },
    // Country is chosen at onboarding and drives currency, timezone, denominations, VAT default and phone format
    // (constants/countries.js). `country` is the display name, kept in sync with `countryCode`.
    countryCode: { type: String, enum: COUNTRY_CODES, default: 'KE' },
    // true once the owner has actively chosen the country (at sign-up, or via the one-time prompt shown to businesses
    // that existed before Tanzania support). Until then the app asks the owner to choose.
    countryConfirmed: { type: Boolean, default: false },
    country: { type: String, default: 'Kenya' },
    // Default language (receipts, invoices, notifications, emails). Each user can override it. Legacy = English.
    language: { type: String, enum: LANGUAGES, default: 'en' },
    taxPin: { type: String, trim: true },
    kraPin: { type: String, trim: true },
    vrn: { type: String, trim: true }, // Tanzania VAT Registration Number (TIN goes in taxPin)
    vatRegistered: { type: Boolean, default: false },
    currency: { type: String, default: 'KES' },
    timezone: { type: String, default: 'Africa/Nairobi' },
    logo: { type: String },

    // Wholesale dashboard settings (warehouse.service#get/updateWholesaleSettings)
    wholesaleSettings: {
      defaultMode: { type: String, enum: ['RETAIL', 'WHOLESALE'], default: 'RETAIL' },
      defaultWarehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
      requireCustomerForWholesale: { type: Boolean, default: false },
      defaultPaymentTermsDays: { type: Number, min: 0, max: 365, default: 0 },
      allowRetailFromWarehouse: { type: Boolean, default: true },
      showUnitSwitcher: { type: Boolean, default: true },
    },

    // Pharmacy rules. Classes and limits are CONFIGURABLE on purpose: set them to match the current PPB schedules with your
    // pharmacist. Empty `classes` = the defaults in constants/pharmacy.js (a starting point, not legal advice).
    pharmacySettings: {
      classes: {
        type: [new Schema({
          code: { type: String, uppercase: true, trim: true, required: true },
          label: String,
          requiresPrescription: { type: Boolean, default: false },
          dispenserOnly: { type: Boolean, default: false },   // behind-the-counter: only an authorised dispenser may sell it
          restricted: { type: Boolean, default: false },      // needs pharmacy.restricted + goes in the controlled register
          maxQtyPerDispense: { type: Number, min: 0 },        // 0/unset = no limit
          poisonsBook: { type: Boolean, default: false },      // a Poisons Book entry (purchaser name, address, purpose, signature) is needed when sold without a prescription
        }, { _id: false })],
        default: [],
      },
      classesConfirmed: { type: new Schema({ at: Date, by: Schema.Types.ObjectId, byName: String, registrationNumber: String, fingerprint: String }, { _id: false }), default: undefined }, // a pharmacist's sign-off that the classes match the current Poisons List; cleared when classes change
      prescriptionValidDays: { type: Number, min: 1, max: 730 },      // unset = the country's default (KE 180, TZ 7)
      refillValidDays: { type: Number, min: 1, max: 730 },
      noRefillsForRestricted: Boolean, oneRestrictedPerPrescription: Boolean, requireCountersign: Boolean, // unset = the country's default
      recordRetentionYears: { type: Number, default: 7, min: 1, max: 30 },   // patient records are not erased inside this period (set per current law)
      requireDispenserCredential: { type: Boolean, default: true }, // dispensing needs a verified PPB credential on the user
      allowOfflineOtc: { type: Boolean, default: false },
      requireApprovedSuppliers: { type: Boolean, default: true },   // medicines can only be bought from approved suppliers with a current licence           // over-the-counter sales at an offline till (never Rx/restricted)
      expiryWarnDays: { type: [Number], default: [30, 60, 90] },
      rooms: { type: [new Schema({ place: String, minC: Number, maxC: Number }, { _id: false })], default: [] }, // storage places and their ranges
    },

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
      acceptMobileMoney: { type: Boolean, default: false }, // M-Pesa/Mixx/Airtel/HaloPesa recorded by reference (Tanzania)
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
        maxManualMpesaCents: { type: Number, min: 0 }, // per-currency cap; unset = utils/offlinePolicy default
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

    layawaySettings: {
      minDepositPercent: { type: Number, default: 20, min: 0, max: 100 },     // first payment must be at least this % of the total
      maxDays: { type: Number, default: 60, min: 7, max: 365 },               // longest a layaway may run
      cancellationFeePercent: { type: Number, default: 10, min: 0, max: 100 }, // kept from what the customer paid if THEY cancel
      graceDays: { type: Number, default: 7, min: 0, max: 60 },               // reminders continue this long after the due date
    },
    tradeInSettings: {
      approvalAboveCents: { type: Number, min: 0 },                            // offers above this need a manager (unset = KES 30,000 / TZS 600,000)
      validDays: { type: Number, default: 7, min: 1, max: 30 },               // how long an accepted offer stays usable
      warrantyMonths: { type: Number, default: 3, min: 0, max: 24 },          // shop warranty on resold trade-in devices
    },

    // Automatic SMS to customers. Everything is OFF until the owner switches it on (each text costs SMS credits).
    smsAlerts: {
      senderId: { type: String, trim: true },             // must be one of the business's approved sender IDs; blank = first approved
      quietHours: {
        enabled: { type: Boolean, default: true },        // hold texts outside these hours (Nairobi time) until morning
        startHour: { type: Number, default: 8, min: 0, max: 23 },
        endHour: { type: Number, default: 20, min: 1, max: 24 },
      },
      ready: { enabled: { type: Boolean, default: false }, template: { type: String, maxlength: 320 } },
      readyReminder: { enabled: { type: Boolean, default: false }, afterDays: { type: [Number], default: () => [3, 7, 14] }, template: { type: String, maxlength: 320 } },
      serviceDue: {
        enabled: { type: Boolean, default: false }, daysBefore: { type: Number, default: 7, min: 0, max: 60 }, kmWindow: { type: Number, default: 500, min: 0, max: 10000 },
        template: { type: String, maxlength: 320 }, overdueTemplate: { type: String, maxlength: 320 },
      },
      warrantyExpiring: { enabled: { type: Boolean, default: false }, daysBefore: { type: Number, default: 14, min: 1, max: 90 }, template: { type: String, maxlength: 320 } },
      insuranceExpiring: { enabled: { type: Boolean, default: false }, daysBefore: { type: Number, default: 14, min: 1, max: 90 }, template: { type: String, maxlength: 320 } },
      layawayDue: { enabled: { type: Boolean, default: false }, daysBefore: { type: Number, default: 3, min: 0, max: 30 }, template: { type: String, maxlength: 320 }, overdueTemplate: { type: String, maxlength: 320 } },
      // Text to the shop OWNER(s) when stock is expired / about to expire (staff alert, not a customer text).
      // Text to the shop OWNER(S) when stock is running low / out. Opt-in; each text uses SMS credits.
      lowStockDigest: { enabled: { type: Boolean, default: false }, frequency: { type: String, enum: ['daily', 'weekly'], default: 'weekly' }, includeOutOfStock: { type: Boolean, default: true }, template: { type: String, maxlength: 320 } },
      expiryDigest: { enabled: { type: Boolean, default: false }, frequency: { type: String, enum: ['daily', 'weekly'], default: 'weekly' }, daysBefore: { type: Number, default: 30, min: 1, max: 180 }, template: { type: String, maxlength: 320 } },
    },

    // In-app alert switches the owner controls (Alerts page). Everything defaults ON so existing shops behave as before.
    alertPrefs: {
      lowStockNotify: { type: Boolean, default: true },
      outOfStockNotify: { type: Boolean, default: true },
    },

    // Expiry watch: how many days ahead a batch turns "critical" (red) / "warning" (orange), and the daily in-app alert.
    expirySettings: {
      criticalDays: { type: Number, default: 30, min: 1, max: 365 },
      warningDays: { type: Number, default: 90, min: 1, max: 730 },
      notifyEnabled: { type: Boolean, default: true },
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

/**
 * Currency integrity. A business has exactly ONE currency, fixed by its country; every stored amount is in it,
 * so books, shifts and reports can never mix units. Country name/currency/timezone are kept consistent with
 * countryCode, and country/currency cannot change on a live business unless country.service#changeCountry
 * (which sets $locals.allowCountryChange after proving there is no money data yet) does it.
 */
businessSchema.pre('validate', function enforceCountryCurrency(next) {
  if (!this.isNew && (this.isModified('countryCode') || this.isModified('currency')) && !(this.$locals && this.$locals.allowCountryChange)) {
    return next(new Error('Country and currency cannot be changed on an existing business'));
  }
  if (this.isNew || this.isModified('countryCode')) {
    const profile = getCountry(this.countryCode);
    this.country = profile.name;
    this.currency = profile.currency;
    if (this.isNew && !this.isModified('timezone')) this.timezone = profile.timezone;
  }
  return next();
});

module.exports = model('Business', businessSchema);
module.exports.BUSINESS_TYPES = BUSINESS_TYPES;