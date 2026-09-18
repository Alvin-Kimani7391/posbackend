const { z } = require('zod');
const mongoose = require('mongoose');

const objectId = z.string().refine((v) => mongoose.Types.ObjectId.isValid(v), {
  message: 'Invalid id',
});

// Accepts local (07..., 01...) or international (2547..., +2547...) Kenyan numbers.
const kenyanPhone = z
  .string()
  .trim()
  .regex(/^(?:\+?254|0)(7|1)\d{8}$/, 'Invalid Kenyan phone number');

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  sort: z.string().trim().optional(),
});

module.exports = { objectId, kenyanPhone, paginationQuery };
