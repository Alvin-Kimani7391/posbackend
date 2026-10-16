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

// Tanzanian mobile numbers: 06x / 07x locally, or 2556x / 2557x internationally.
const tanzanianPhone = z
  .string()
  .trim()
  .regex(/^(?:\+?255|0)[67]\d{8}$/, 'Invalid Tanzanian phone number');

// Where the validator cannot know the country (e.g. creating an employee) accept a valid number from ANY supported
// country; the service then checks it against the business's own country.
const anyPhone = z
  .string()
  .trim()
  .refine((v) => /^(?:\+?254|0)(7|1)\d{8}$/.test(v.replace(/[\s-]/g, '')) || /^(?:\+?255|0)[67]\d{8}$/.test(v.replace(/[\s-]/g, '')), 'Invalid phone number');

const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().optional(),
  sort: z.string().trim().optional(),
});

module.exports = { objectId, kenyanPhone, tanzanianPhone, anyPhone, paginationQuery };
