const { z } = require('zod');

const updateMpesaSchema = z.object({
  enabled: z.boolean().optional(),
  channelId: z.string().trim().min(1).optional(),
  apiUsername: z.string().trim().min(1).optional(),
  apiPassword: z.string().trim().min(1).optional(),
}).refine((d) => (d.apiUsername && d.apiPassword) || (!d.apiUsername && !d.apiPassword), {
  message: 'apiUsername and apiPassword must be provided together',
});

const updateEtimsSchema = z.object({
  enabled: z.boolean().optional(),
  environment: z.enum(['sandbox', 'production']).optional(),
  kraPin: z.string().trim().min(9).optional(),
  apiKey: z.string().trim().min(1).optional(),
  username: z.string().trim().optional(),
  password: z.string().trim().optional(),
});

module.exports = { updateMpesaSchema, updateEtimsSchema };