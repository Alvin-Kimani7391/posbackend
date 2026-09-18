const { z } = require('zod');

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
    receiptSettings: z.record(z.any()).optional(),
    taxSettings: z.record(z.any()).optional(),
    paymentSettings: z.record(z.any()).optional(),
    settings: z.record(z.any()).optional(),
  })
  .strict();

module.exports = { updateBusinessSchema };
