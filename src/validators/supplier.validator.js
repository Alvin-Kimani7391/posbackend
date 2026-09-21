const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');

const createSupplierSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional(),
  email: z.string().trim().email().optional(),
  address: z.string().trim().optional(),
  taxPin: z.string().trim().optional(),
  contactPerson: z.string().trim().optional(),
  paymentTerms: z.string().trim().optional(),
});

const updateSupplierSchema = createSupplierSchema.partial();
const listSuppliersQuery = paginationQuery;
const idParamSchema = z.object({ id: objectId });

module.exports = { createSupplierSchema, updateSupplierSchema, listSuppliersQuery, idParamSchema };
