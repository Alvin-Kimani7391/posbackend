const { z } = require('zod');
const { BUSINESS_TYPES, FEATURE_KEYS } = require('../constants/businessFeatures');
const { ONBOARDING_STEP_KEYS } = require('../constants/onboarding');
const { LANGUAGES, COUNTRY_CODES } = require('../constants/countries');

const receiptSettingsSchema = z
  .object({
    footerMessage: z.string().trim().optional(),
    headerMessage: z.string().trim().optional(),
    showLogo: z.boolean().optional(),
    showKraPin: z.boolean().optional(),
    showCashierName: z.boolean().optional(),
    showMpesaReceiptCode: z.boolean().optional(),
    receiptPrefix: z.string().trim().optional(),
    invoicePrefix: z.string().trim().optional(),
    paperWidth: z.enum(['58mm', '80mm']).optional(),
    customLines: z.array(z.string().trim()).optional(),
  })
  .strict();

const taxSettingsSchema = z
  .object({
    taxInclusive: z.boolean().optional(),
    defaultTaxRate: z.coerce.number().min(0).max(100).optional(),
  })
  .strict();

const paymentSettingsSchema = z
  .object({
    acceptCash: z.boolean().optional(),
    acceptMpesa: z.boolean().optional(),
    acceptMobileMoney: z.boolean().optional(),
    acceptCard: z.boolean().optional(),
    acceptBank: z.boolean().optional(),
    acceptCredit: z.boolean().optional(),
  })
  .strict();

// NOTE: enableCustomerCredit is the flag sale.service.js actually checks
// before allowing a partial/credit sale (business.settings.enableCustomerCredit).
const businessSettingsSchema = z
  .object({
    allowNegativeStock: z.boolean().optional(),
    requireManagerRefundApproval: z.boolean().optional(),
    cashierPriceOverride: z.boolean().optional(),
    maxCashierDiscountPercent: z.coerce.number().min(0).max(100).optional(),
    maxManagerDiscountPercent: z.coerce.number().min(0).max(100).optional(),
    enableCustomerCredit: z.boolean().optional(),
    enableLoyalty: z.boolean().optional(),
    enableOfflineMode: z.boolean().optional(),
    requireShift: z.boolean().optional(),
    enableSMSReceipts: z.boolean().optional(),
    enableWhatsAppReceipts: z.boolean().optional(),
    enableEmailReceipts: z.boolean().optional(),
  })
  .strict();

const featureSettingsSchema = z
  .object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean().optional()])))
  .strict();

const updateBusinessSchema = z
  .object({
    name: z.string().trim().min(2).optional(),
    legalName: z.string().trim().optional(),
    businessType: z.enum(BUSINESS_TYPES).optional(),
    businessSubtype: z.string().trim().max(60).optional(),
    featureSettings: featureSettingsSchema.optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().email().optional(),
    address: z.string().trim().optional(),
    county: z.string().trim().optional(),
    town: z.string().trim().optional(),
    taxPin: z.string().trim().optional(),
    kraPin: z.string().trim().optional(),
    vrn: z.string().trim().max(30).optional(),
    language: z.enum(LANGUAGES).optional(),
    vatRegistered: z.boolean().optional(),
    currency: z.string().trim().optional(), // accepted for old clients but must equal the (locked) business currency
    timezone: z.string().trim().optional(),
    logo: z.string().trim().optional(),
    receiptSettings: receiptSettingsSchema.optional(),
    taxSettings: taxSettingsSchema.optional(),
    paymentSettings: paymentSettingsSchema.optional(),
    settings: businessSettingsSchema.optional(),
  })
  .strict();

// Setup guide. One request can do several things; every field is optional.
//   typeConfirmed: true            -> the owner has made a business-type decision (or kept the default)
//   snoozeTypePrompt: true         -> "ask me later" for the pop-up (existing businesses)
//   step: { key, status }          -> mark a step 'done' / 'skipped', or 'pending' to undo
//   dismissed: true | false        -> leave the guide for now / resume it
//   completed: true | false        -> the owner finished the whole guide
const updateOnboardingSchema = z
  .object({
    typeConfirmed: z.boolean().optional(),
    snoozeTypePrompt: z.boolean().optional(),
    step: z
      .object({
        key: z.enum(ONBOARDING_STEP_KEYS),
        status: z.enum(['done', 'skipped', 'pending']),
      })
      .strict()
      .optional(),
    dismissed: z.boolean().optional(),
    completed: z.boolean().optional(),
  })
  .strict();

// Fix a wrong country choice - only works while the business has no money data (see country.service).
const countrySchema = z
  .object({
    countryCode: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.enum(COUNTRY_CODES)),
    language: z.enum(LANGUAGES).optional(),
  })
  .strict();

module.exports = { updateBusinessSchema, updateOnboardingSchema, countrySchema };