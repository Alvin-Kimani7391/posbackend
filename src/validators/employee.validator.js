const { z } = require('zod');
const { objectId, kenyanPhone } = require('./common');
const { ROLES } = require('../constants/roles');

const roleEnum = z.enum(Object.values(ROLES));

const createEmployeeSchema = z
  .object({
    name: z.string().trim().min(2),
    email: z.string().trim().email().optional(),
    phone: kenyanPhone,
    role: roleEnum,
    employeeCode: z.string().trim().min(2).optional(),
    branchIds: z.array(objectId).default([]),
    password: z.string().min(8).optional(),
    pin: z.string().min(4).max(8).optional(),
  })
  .refine((data) => data.password || data.pin, {
    message: 'Either password or pin must be provided',
    path: ['password'],
  });

const updateEmployeeSchema = z.object({
  name: z.string().trim().min(2).optional(),
  email: z.string().trim().email().optional(),
  phone: kenyanPhone.optional(),
  role: roleEnum.optional(),
  employeeCode: z.string().trim().optional(),
  branchIds: z.array(objectId).optional(),
  grantedPermissions: z.array(z.string()).optional(),
  revokedPermissions: z.array(z.string()).optional(),
});

const statusSchema = z.object({
  status: z.enum(['active', 'inactive', 'suspended']),
});

const idParamSchema = z.object({ id: objectId });

module.exports = { createEmployeeSchema, updateEmployeeSchema, statusSchema, idParamSchema };
