const { z } = require('zod');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const isoDate = z.string().datetime({ offset: true }).optional();

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(15),
  search: z.string().trim().max(100).optional(),
};

const idParamSchema = z.object({ id: objectId });

const overviewQuery = z.object({ from: isoDate, to: isoDate });

const businessesQuery = z.object({
  ...paging,
  status: z.enum(['active', 'suspended', 'closed']).optional(),
});

const salesQuery = z.object({
  ...paging,
  businessId: objectId.optional(),
  paymentStatus: z.enum(['PAID', 'PARTIAL', 'UNPAID', 'CREDIT']).optional(),
  saleStatus: z.enum(['COMPLETED', 'CANCELLED']).optional(),
  from: isoDate,
  to: isoDate,
});

const employeesQuery = z.object({
  ...paging,
  businessId: objectId.optional(),
  role: z.enum(['OWNER', 'ADMIN', 'MANAGER', 'CASHIER', 'STOREKEEPER', 'ACCOUNTANT']).optional(),
  status: z.enum(['active', 'inactive', 'suspended']).optional(),
});

const productsQuery = z.object({
  ...paging,
  businessId: objectId.optional(),
  status: z.enum(['active', 'archived']).optional(),
});

const auditQuery = z.object({
  ...paging,
  businessId: objectId.optional(),
  from: isoDate,
  to: isoDate,
});

const businessStatusSchema = z.object({ status: z.enum(['active', 'suspended']) });
const employeeStatusSchema = z.object({ status: z.enum(['active', 'inactive', 'suspended']) });

module.exports = {
  idParamSchema, overviewQuery, businessesQuery, salesQuery, employeesQuery,
  productsQuery, auditQuery, businessStatusSchema, employeeStatusSchema,
};