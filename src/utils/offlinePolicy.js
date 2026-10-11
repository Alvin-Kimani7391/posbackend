'use strict';

/**
 * Per-business offline policy (stored at Business.settings.offline).
 * The business policy is always the CEILING: a device can only be stricter.
 *
 * HARD_MAX_OFFLINE_HOURS is a safety cap nobody can exceed. Revisit it once KRA /
 * DigiTax confirm in writing how long invoices may be fiscalised late.
 */
const HARD_MAX_OFFLINE_HOURS = 72;

const DEFAULTS = Object.freeze({
  enabled: false,                    // conservative: owner must opt in
  maxOfflineHours: 12,               // till refuses new sales after this long offline
  sessionHours: 12,                  // how long an unlocked cashier stays unlocked offline
  maxPendingSales: 200,              // till blocks new sales above this many unsynced sales
  maxPendingValueCents: 20000000,    // KES 200,000 in cents
  syncCustomers: false,              // send customer names/phones/credit balances to tills (needed for offline credit); off = no customer personal data on devices
  allowCredit: false,                // customer balances on the device are stale -> off by default
  allowManualMpesa: false,           // customer pays the Till, cashier records the M-PESA code + phone; verified/approved at sync
  manualMpesaApproval: 'UNMATCHED_ONLY', // UNMATCHED_ONLY = auto-verify codes found in the till inbox, manager approves the rest; ALWAYS = manager approves every offline M-PESA
  maxManualMpesaCents: 5000000,      // KES 50,000 per offline M-PESA payment; above this always needs approval
  allowCard: false,
  allowRefunds: false,
  maxDiscountPercent: 5,             // applies to every role offline, owners included
  allowShiftCloseWithPending: false,
  sharedDeviceMaxOfflineHours: 4,
  defaultDeviceMode: 'DEDICATED',
});

const POLICY_KEYS = Object.keys(DEFAULTS);

const clampHours = (v, fallback) => Math.min(Math.max(Number(v) || fallback, 1), HARD_MAX_OFFLINE_HOURS);

/** Reads policy from a Business document/lean object, filling any missing key from DEFAULTS. */
function getPolicy(business) {
  const stored = (business && business.settings && business.settings.offline) || {};
  const policy = {};
  for (const key of POLICY_KEYS) {
    policy[key] = stored[key] !== undefined && stored[key] !== null ? stored[key] : DEFAULTS[key];
  }
  policy.maxOfflineHours = clampHours(policy.maxOfflineHours, DEFAULTS.maxOfflineHours);
  policy.sharedDeviceMaxOfflineHours = clampHours(policy.sharedDeviceMaxOfflineHours, DEFAULTS.sharedDeviceMaxOfflineHours);
  return policy;
}

/** Offline window for one device: business ceiling, then shared-device cap, then any stricter per-device override. */
function effectiveOfflineHours(policy, device) {
  let hours = policy.maxOfflineHours;
  if (device && device.mode === 'SHARED') hours = Math.min(hours, policy.sharedDeviceMaxOfflineHours);
  if (device && device.maxOfflineHoursOverride) hours = Math.min(hours, device.maxOfflineHoursOverride);
  return Math.max(1, Math.min(hours, HARD_MAX_OFFLINE_HOURS));
}

module.exports = { HARD_MAX_OFFLINE_HOURS, DEFAULTS, POLICY_KEYS, getPolicy, effectiveOfflineHours };