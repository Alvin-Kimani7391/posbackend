const { z } = require('zod');
const verifyReceiptSchema = z.object({
  token: z.string().trim().min(1).max(128).optional(),
  receiptNumber: z.string().trim().min(1).max(80).optional(),
}).refine((v) => v.token || v.receiptNumber, { message: 'Provide the QR token or a receipt number' });
module.exports = { verifyReceiptSchema };
