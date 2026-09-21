const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const { EXPENSE_CATEGORIES } = require('../models/Expense');

const moneyInput = z.coerce.number().positive().transform(toCents);

const createExpenseSchema = z.object({
  branchId: objectId,
  category: z.enum(EXPENSE_CATEGORIES),
  amount: moneyInput,
  description: z.string().trim().optional(),
  paymentMethod: z.enum(['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER']).optional().default('CASH'),
  reference: z.string().trim().optional(),
  receiptImage: z.string().trim().optional(),
  expenseDate: z.coerce.date().optional(),
});

const listExpensesQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const rejectExpenseSchema = z.object({ rejectionReason: z.string().trim().min(1) });
const idParamSchema = z.object({ id: objectId });

module.exports = { createExpenseSchema, listExpensesQuery, rejectExpenseSchema, idParamSchema };
