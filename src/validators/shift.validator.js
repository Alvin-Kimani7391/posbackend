const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');
const { DENOMINATIONS } = require('../utils/denominations');

const moneyInput = z.coerce.number().nonnegative().transform(toCents);

const createRegisterSchema = z.object({
  branchId: objectId,
  name: z.string().trim().min(1),
  code: z.string().trim().min(1).max(10),
});
const updateRegisterSchema = z.object({
  name: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const openShiftSchema = z.object({
  branchId: objectId,
  registerId: objectId,
  openingCash: moneyInput,
});

const denominationLine = z.object({
  denomination: z.coerce.number().refine((v) => DENOMINATIONS.includes(v), 'Unsupported denomination'),
  count: z.coerce.number().int('Count must be a whole number').nonnegative().max(1000000),
});

const closeShiftSchema = z.object({
  // The cashier's count per note/coin. The server derives the counted total from this.
  denominations: z
    .array(denominationLine)
    .min(1, 'Enter the count for each denomination')
    .refine((lines) => new Set(lines.map((l) => l.denomination)).size === lines.length, 'Duplicate denomination'),
  // Optional: if a client sends it, it must equal the denominations total (checked in the service).
  actualCash: moneyInput.optional(),
  notes: z.string().trim().optional(),
});

const listShiftsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const currentShiftQuery = z.object({ branchId: objectId });
const idParamSchema = z.object({ id: objectId });

module.exports = { createRegisterSchema, updateRegisterSchema, openShiftSchema, closeShiftSchema, listShiftsQuery, currentShiftQuery, idParamSchema };