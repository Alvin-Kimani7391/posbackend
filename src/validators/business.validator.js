const { z } = require('zod');

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

const updateBusinessSchema = z
  .object({
    name: z.string().trim().min(2).optional(),
    legalName: z.string().trim().optional(),
    businessType: z
      .enum(['supermarket', 'electronics', 'clothing', 'hardware', 'cosmetics', 'restaurant', 'general_shop', 'wholesale', 'other'])
      .optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().email().optional(),
    address: z.string().trim().optional(),
    county: z.string().trim().optional(),
    town: z.string().trim().optional(),
    taxPin: z.string().trim().optional(),
    kraPin: z.string().trim().optional(),
    vatRegistered: z.boolean().optional(),
    currency: z.string().trim().optional(),
    timezone: z.string().trim().optional(),
    logo: z.string().trim().optional(),
    receiptSettings: receiptSettingsSchema.optional(),
    taxSettings: taxSettingsSchema.optional(),
    paymentSettings: paymentSettingsSchema.optional(),
    settings: businessSettingsSchema.optional(),
  })
  .strict();

module.exports = { updateBusinessSchema };