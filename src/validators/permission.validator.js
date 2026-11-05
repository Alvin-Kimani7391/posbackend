const { z } = require('zod');
const { objectId } = require('./common');

const permKey = z.string().trim().min(3).max(80);
const permList = z.array(permKey).max(500);
const mode = z.enum(['default', 'custom']);

const employeeAccessSchema = z.object({
  mode: mode.optional(),
  groupIds: z.array(objectId).max(20).optional(),
  grant: permList.optional(),
  revoke: permList.optional(),
  reset: z.boolean().optional(),
});

const bulkSchema = z.object({
  employeeIds: z.array(objectId).min(1).max(200),
  op: z.enum(['setMode', 'addGroup', 'removeGroup', 'grant', 'revoke', 'inherit', 'reset']),
  mode: mode.optional(),
  groupId: objectId.optional(),
  permissions: permList.optional(),
});

const templateSchema = z.object({ grant: permList.default([]), revoke: permList.default([]) });

const groupSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  color: z.string().trim().max(20).optional(),
  grant: permList.default([]),
  revoke: permList.default([]),
});
const groupUpdateSchema = groupSchema.partial();

const idParam = z.object({ id: objectId });
const groupParam = z.object({ groupId: objectId });
const roleParam = z.object({ role: z.string().trim().min(2).max(40) });

module.exports = { employeeAccessSchema, bulkSchema, templateSchema, groupSchema, groupUpdateSchema, idParam, groupParam, roleParam };
