const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { getDenominations } = require('../utils/denominations');
const { invalidateBusinessContext, buildContext } = require('../utils/businessContext');
const countryService = require('./country.service');
const { resolveFeatures, BUSINESS_TYPES, FEATURE_KEYS, BUSINESS_FEATURE_DEFAULTS, LOCKED_ON, defaultsFor } = require('../constants/businessFeatures');

// Fields an ADMIN/OWNER may edit. Never allow status/subscription fields to be
// set from this route - those are controlled by billing/admin processes.
const EDITABLE_FIELDS = [
  'name', 'legalName', 'businessType', 'phone', 'email', 'address', 'county', 'town',
  'taxPin', 'kraPin', 'vrn', 'vatRegistered', 'timezone', 'logo', 'language',
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

  // Currency is fixed by the country chosen at onboarding - every stored amount is in it. Older clients may echo
  // the current value back; anything else is refused.
  if (updates.currency !== undefined && updates.currency !== business.currency) {
    throw ApiError.badRequest(
      `The currency of this business is ${business.currency} and cannot be changed. (Wrong country? Use PUT /business/country before adding any data.)`,
      'CURRENCY_LOCKED'
    );
  }
  // Tanzania: the TIN has 9 digits, shown as 123-456-789.
  if (updates.taxPin && business.countryCode === 'TZ') {
    const digits = String(updates.taxPin).replace(/[\s-]/g, '');
    if (!/^\d{9}$/.test(digits)) throw ApiError.badRequest('A Tanzanian TIN has 9 digits (e.g. 123-456-789)', 'INVALID_TAX_ID');
    updates = { ...updates, taxPin: `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` };
  }

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
  invalidateBusinessContext(businessId);

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
    .select('name businessType businessSubtype featureSettings currency countryCode country countryConfirmed language timezone onboarding.typeConfirmed')
    .lean();
  if (!b) throw ApiError.notFound('Business not found');
  const fs = b.featureSettings || {};
  const ctx = buildContext(b);
  return {
    id: b._id,
    name: b.name,
    // Country drives currency, notes/coins, tax labels and which integrations exist: the app renders from this
    // block instead of hard-coding Kenya.
    country: {
      code: ctx.countryCode, name: ctx.country.name, flag: ctx.country.flag, flagCode: ctx.country.flagCode, currency: ctx.currency, timezone: ctx.timezone,
      language: ctx.language, languages: ctx.country.languages, vatRate: ctx.country.vatRate,
      taxAuthority: ctx.country.taxAuthority, taxIdLabel: ctx.country.taxIdLabel, dialCode: ctx.country.dialCode,
      denominations: getDenominations(ctx.currency), mobileMoney: ctx.country.mobileMoney, integrations: ctx.country.integrations,
    },
    // Existing (pre-Tanzania) businesses are asked once to pick Kenya or Tanzania; the app shows the picker while this is true.
    countryConfirmed: b.countryConfirmed === true,
    needsCountrySelection: b.countryConfirmed !== true,
    language: ctx.language,
    businessType: b.businessType || 'general_shop',
    businessSubtype: b.businessSubtype || '',
    currency: ctx.currency,
    typeConfirmed: !!(b.onboarding && b.onboarding.typeConfirmed),
    featureSettings: Object.fromEntries(FEATURE_KEYS.map((k) => [k, fs[k] === true])),
  };
}

/** Small block for login / me responses: enough to draw the flag in the dashboard and decide whether to show the country picker. */
async function getCountrySummary(businessId) {
  if (!businessId) return null;
  const p = await getProfile(businessId);
  return {
    code: p.country.code, name: p.country.name, flag: p.country.flag, flagCode: p.country.flagCode,
    currency: p.country.currency, language: p.language, needsCountrySelection: p.needsCountrySelection,
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

const changeCountry = (businessId, userId, input) => countryService.changeCountry(businessId, userId, input);

module.exports = { getOwnBusiness, updateOwnBusiness, changeCountry, getProfile, getCountrySummary, getTypeCatalogue, getOnboarding, updateOnboarding };