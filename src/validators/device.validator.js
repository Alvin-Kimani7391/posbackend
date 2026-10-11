const { z } = require('zod');
const { objectId } = require('./common');

// Client-generated UUID-style id. URL-safe characters only.
const deviceIdStr = z.string().trim().min(16).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid device id');
const modeEnum = z.enum(['DEDICATED', 'SHARED']);

const enrollDeviceSchema = z.object({
  branchId: objectId,
  deviceId: deviceIdStr,
  deviceName: z.string().trim().min(1).max(60),
  deviceType: z.enum(['POS', 'TABLET', 'PHONE', 'WEB', 'OTHER']).optional(),
  mode: modeEnum.optional(),
  offlineEnabled: z.boolean().optional(),
});

const updateDeviceSchema = z
  .object({
    deviceName: z.string().trim().min(1).max(60),
    mode: modeEnum,
    offlineEnabled: z.boolean(),
    maxOfflineHoursOverride: z.number().int().min(1).max(72).nullable(),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

const revokeDeviceSchema = z.object({ reason: z.string().trim().min(1).max(200) });
const grantSchema = z.object({ deviceId: deviceIdStr });
const heartbeatSchema = z.object({
  deviceId: deviceIdStr,
  appVersion: z.string().trim().max(40).optional(),
  pendingCount: z.number().int().min(0).optional(),
});
const listDevicesQuery = z.object({ branchId: objectId.optional() });
const idParamSchema = z.object({ id: objectId });

// Money here is INTEGER CENTS on purpose (explicit "Cents" suffix). The settings screen converts KES <-> cents.
const offlinePolicySchema = z
  .object({
    enabled: z.boolean(),
    maxOfflineHours: z.number().int().min(1).max(72),
    sessionHours: z.number().int().min(1).max(24),
    maxPendingSales: z.number().int().min(1).max(5000),
    maxPendingValueCents: z.number().int().min(0).max(2000000000),
    allowCredit: z.boolean(),
    syncCustomers: z.boolean(),
    allowManualMpesa: z.boolean(),
    manualMpesaApproval: z.enum(['UNMATCHED_ONLY', 'ALWAYS']),
    maxManualMpesaCents: z.number().int().min(0).max(2000000000),
    allowCard: z.boolean(),
    allowRefunds: z.boolean(),
    maxDiscountPercent: z.number().min(0).max(100),
    allowShiftCloseWithPending: z.boolean(),
    sharedDeviceMaxOfflineHours: z.number().int().min(1).max(72),
    defaultDeviceMode: modeEnum,
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Nothing to update');

module.exports = {
  enrollDeviceSchema, updateDeviceSchema, revokeDeviceSchema, grantSchema, heartbeatSchema,
  listDevicesQuery, idParamSchema, offlinePolicySchema,
};