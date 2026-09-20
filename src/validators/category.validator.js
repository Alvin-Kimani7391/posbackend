const { z } = require('zod');
const { objectId } = require('./common');

const createCategorySchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().optional(),
  parentCategoryId: objectId.optional(),
  image: z.string().trim().optional(),
});

const updateCategorySchema = createCategorySchema.partial();

const idParamSchema = z.object({ id: objectId });

module.exports = { createCategorySchema, updateCategorySchema, idParamSchema };
