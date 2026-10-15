const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { resolveFeatures, BUSINESS_TYPES, FEATURE_KEYS, BUSINESS_FEATURE_DEFAULTS, LOCKED_ON, defaultsFor } = require('../constants/businessFeatures');

// Fields an ADMIN/OWNER may edit. Never allow status/subscription fields to be
// set from this route - those are controlled by billing/admin processes.
const EDITABLE_FIELDS = [
  'name', 'legalName', 'businessType', 'phone', 'email', 'address', 'county', 'town',
  'taxPin', 'kraPin', 'vatRegistered', 'currency', 'timezone', 'logo',
  'receiptSettings', 'taxSettings', 'paymentSettings', 'settings',
  'businessSubtype', 'featureSettings',
];

// These fields are nested objects on the Business schema (sub-documents),
// not scalars. A caller is allowed to send just the one or two keys they
// actually changed (e.g. { settings: { enableCustomerCredit: true } }), so
// we MERGE into the existing sub-object instead of overwriting it wholesale.
// Overwriting would silently blank out every sibling setting the caller
// didn't mention (requireShift, allowNegativeStock, maxCashierDiscountPercent...).
const NESTED_OBJECT_FIELDS = ['receiptSettings', 'taxSettings', 'paymentSettings', 'settings'];
// featureSettings is handled separately below (type defaults + locked-on rules).

async function getOwnBusiness(businessId) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');
  return business;
}

async function updateOwnBusiness(businessId, userId, updates) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');

  const oldValue = business.toObject();

  for (const field of EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) continue;

    if (field === 'featureSettings') continue;

    if (NESTED_OBJECT_FIELDS.includes(field)) {
      // Merge, don't replace - see NESTED_OBJECT_FIELDS comment above.
      Object.assign(business[field], updates[field]);
      business.markModified(field);
    } else {
      business[field] = updates[field];
    }
  }

  // Feature flags: apply the (possibly new) type's defaults additively, honour explicit
  // overrides, and keep locked-on features (e.g. pharmacy batch tracking) on.
  if (updates.featureSettings || updates.businessType) {
    const current = business.featureSettings ? business.featureSettings.toObject() : {};
    business.featureSettings = resolveFeatures(business.businessType, current, updates.featureSettings || {});
    business.markModified('featureSettings');
  }

  await business.save();

  await AuditLog.create({
    businessId,
    userId,
    action: 'business.update',
    entityType: 'Business',
    entityId: business._id,
    oldValue,
    newValue: business.toObject(),
  });

  return business;
}

/**
 * What EVERY signed-in user may know about the business: its type and which feature flags are on.
 * The frontend uses this to personalise the menu for all roles (a cashier has no settings.view, so
 * they cannot call GET /business). Nothing sensitive here - no tax pins, no payment settings.
 */
async function getProfile(businessId) {
  const b = await Business.findById(businessId)
    .select('name businessType businessSubtype featureSettings currency onboarding.typeConfirmed')
    .lean();
  if (!b) throw ApiError.notFound('Business not found');
  const fs = b.featureSettings || {};
  return {
    id: b._id,
    name: b.name,
    businessType: b.businessType || 'general_shop',
    businessSubtype: b.businessSubtype || '',
    currency: b.currency || 'KES',
    typeConfirmed: !!(b.onboarding && b.onboarding.typeConfirmed),
    featureSettings: Object.fromEntries(FEATURE_KEYS.map((k) => [k, fs[k] === true])),
  };
}

/** The backend's own type list + feature defaults + locked-on rules, so the UI never drifts from it. */
function getTypeCatalogue() {
  return {
    types: BUSINESS_TYPES.map((key) => ({
      key,
      defaults: defaultsFor(key),
      lockedOn: LOCKED_ON[key] || [],
      hasPreset: Object.prototype.hasOwnProperty.call(BUSINESS_FEATURE_DEFAULTS, key),
    })),
    featureKeys: FEATURE_KEYS,
  };
}

function serialiseOnboarding(business) {
  const o = business.onboarding || {};
  return {
    businessType: business.businessType || 'general_shop',
    typeConfirmed: !!o.typeConfirmed,
    typeConfirmedAt: o.typeConfirmedAt || null,
    typePromptSnoozedUntil: o.typePromptSnoozedUntil || null,
    steps: (o.steps || []).map((s) => ({ key: s.key, status: s.status, at: s.at })),
    dismissedAt: o.dismissedAt || null,
    completedAt: o.completedAt || null,
  };
}

async function getOnboarding(businessId) {
  const business = await Business.findById(businessId).select('businessType onboarding');
  if (!business) throw ApiError.notFound('Business not found');
  return serialiseOnboarding(business);
}

const SNOOZE_DAYS = 3;

async function updateOnboarding(businessId, userId, input) {
  const business = await Business.findById(businessId).select('businessType onboarding');
  if (!business) throw ApiError.notFound('Business not found');
  if (!business.onboarding) business.onboarding = {};
  const o = business.onboarding;

  if (input.typeConfirmed === true) {
    o.typeConfirmed = true;
    o.typeConfirmedAt = new Date();
    o.typePromptSnoozedUntil = undefined;
  }
  if (input.snoozeTypePrompt === true) {
    o.typePromptSnoozedUntil = new Date(Date.now() + SNOOZE_DAYS * 86400000);
  }
  if (input.step) {
    const { key, status } = input.step;
    const rest = (o.steps || []).filter((s) => s.key !== key);
    o.steps = status === 'pending' ? rest : [...rest, { key, status, at: new Date() }];
    // Re-opening any step means the guide is no longer finished.
    if (status === 'pending') o.completedAt = undefined;
  }
  if (input.dismissed === true) o.dismissedAt = new Date();
  if (input.dismissed === false) o.dismissedAt = undefined; // "resume setup guide"
  if (input.completed === true) { o.completedAt = new Date(); o.dismissedAt = undefined; }
  if (input.completed === false) o.completedAt = undefined;

  business.markModified('onboarding');
  await business.save();

  await AuditLog.create({
    businessId, userId, action: 'business.onboarding.update', entityType: 'Business', entityId: business._id,
    newValue: { input },
  });
  return serialiseOnboarding(business);
}

module.exports = { getOwnBusiness, updateOwnBusiness, getProfile, getTypeCatalogue, getOnboarding, updateOnboarding };