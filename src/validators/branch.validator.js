const { z } = require('zod');
const { objectId } = require('./common');

const createBranchSchema = z.object({
  name: z.string().trim().min(2),
  code: z.string().trim().min(2).max(10),
  phone: z.string().trim().optional(),
  address: z.string().trim().optional(),
  county: z.string().trim().optional(),
  town: z.string().trim().optional(),
  managerId: objectId.optional(),
});

const updateBranchSchema = createBranchSchema.partial();

const idParamSchema = z.object({ id: objectId });

module.exports = { createBranchSchema, updateBranchSchema, idParamSchema };
