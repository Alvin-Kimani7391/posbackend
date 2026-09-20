const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const moneyInput = z.coerce.number().nonnegative().transform(toCents);

const createCustomerSchema = z.object({
  name: z.string().trim().min(1),
  phone: z.string().trim().optional(),
  email: z.string().trim().email().optional(),
  address: z.string().trim().optional(),
  customerNumber: z.string().trim().optional(),
});

const updateCustomerSchema = createCustomerSchema.partial();

const setCreditLimitSchema = z.object({ creditLimit: moneyInput });

const recordPaymentSchema = z.object({
  branchId: objectId,
  method: z.enum(['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER']),
  amount: moneyInput,
  reference: z.string().trim().optional(),
});

const listCustomersQuery = paginationQuery;
const idParamSchema = z.object({ id: objectId });

module.exports = { createCustomerSchema, updateCustomerSchema, setCreditLimitSchema, recordPaymentSchema, listCustomersQuery, idParamSchema };
