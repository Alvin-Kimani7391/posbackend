const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

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

const closeShiftSchema = z.object({
  actualCash: moneyInput,
  notes: z.string().trim().optional(),
});

const listShiftsQuery = paginationQuery.extend({
  branchId: objectId.optional(),
  cashierId: objectId.optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});

const currentShiftQuery = z.object({ branchId: objectId });
const idParamSchema = z.object({ id: objectId });

module.exports = { createRegisterSchema, updateRegisterSchema, openShiftSchema, closeShiftSchema, listShiftsQuery, currentShiftQuery, idParamSchema };
