const IntegrationSettings = require('../models/IntegrationSettings');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { encrypt, maskedHint } = require('../utils/crypto');
const { ROLES } = require('../constants/roles');
const payhero = require('../integrations/mpesa/payhero.provider');
const digitax = require('../integrations/etims/digitax.client');

async function getOrCreate(businessId) {
  let settings = await IntegrationSettings.findOne({ businessId });
  if (!settings) settings = await IntegrationSettings.create({ businessId });
  return settings;
}

/** Owner dashboard status view - NEVER includes credentialsBlob, only booleans/non-secret config. */
async function getStatus(businessId) {
  const settings = await getOrCreate(businessId);
  return {
    mpesa: {
      enabled: settings.mpesa.enabled,
      provider: settings.mpesa.provider,
      channelId: settings.mpesa.channelId || null,
      credentials: maskedHint(settings.mpesa.credentialsBlob ? 'x' : null),
      configuredAt: settings.mpesa.credentialsSetAt,
    },
    etims: {
      enabled: settings.etims.enabled,
      provider: settings.etims.provider,
      environment: settings.etims.environment,
      kraPin: settings.etims.kraPin || null,
      credentials: maskedHint(settings.etims.credentialsBlob ? 'x' : null),
      configuredAt: settings.etims.credentialsSetAt,
    },
  };
}

/** Same as getStatus but strips to just the two flags - safe for CASHIER-level roles so the POS UI knows whether to offer STK push. */
async function getFlagsForPos(businessId) {
  const settings = await getOrCreate(businessId);
  return { mpesaEnabled: settings.mpesa.enabled, etimsEnabled: settings.etims.enabled };
}

function assertOwner(user) {
  // Credentials are money/tax-critical - deliberately stricter than the
  // general settings.update permission (which ADMIN also has).
  if (user.role !== ROLES.OWNER) {
    throw ApiError.forbidden('Only the business owner can configure payment/tax integrations', 'OWNER_ONLY');
  }
}

async function updateMpesa(businessId, user, { enabled, channelId, apiUsername, apiPassword }) {
  assertOwner(user);
  const settings = await getOrCreate(businessId);
  const changed = [];

  if (enabled !== undefined) { settings.mpesa.enabled = enabled; changed.push('enabled'); }
  if (channelId !== undefined) { settings.mpesa.channelId = channelId; changed.push('channelId'); }
  if (apiUsername && apiPassword) {
    settings.mpesa.credentialsBlob = encrypt({ apiUsername, apiPassword });
    settings.mpesa.credentialsSetAt = new Date();
    changed.push('credentials');
  }
  if (settings.mpesa.enabled && (!settings.mpesa.channelId || !settings.mpesa.credentialsBlob)) {
    throw ApiError.badRequest('Set a channel ID and API credentials before enabling M-PESA', 'MPESA_INCOMPLETE_CONFIG');
  }
  settings.mpesa.updatedBy = user._id;
  await settings.save();

  await AuditLog.create({ businessId, userId: user._id, action: 'settings.mpesa.update', entityType: 'IntegrationSettings', entityId: settings._id, newValue: { changedFields: changed } });
  return getStatus(businessId);
}

async function updateEtims(businessId, user, { enabled, environment, kraPin, apiKey, username, password }) {
  assertOwner(user);
  const settings = await getOrCreate(businessId);
  const changed = [];

  if (enabled !== undefined) { settings.etims.enabled = enabled; changed.push('enabled'); }
  if (environment !== undefined) { settings.etims.environment = environment; changed.push('environment'); }
  if (kraPin !== undefined) { settings.etims.kraPin = kraPin; changed.push('kraPin'); }
  if (apiKey) {
    settings.etims.credentialsBlob = encrypt({ apiKey, username, password });
    settings.etims.credentialsSetAt = new Date();
    changed.push('credentials');
  }
  if (settings.etims.enabled && (!settings.etims.kraPin || !settings.etims.credentialsBlob)) {
    throw ApiError.badRequest('Set a KRA PIN and DigiTax credentials before enabling eTIMS', 'ETIMS_INCOMPLETE_CONFIG');
  }
  settings.etims.updatedBy = user._id;
  await settings.save();

  await AuditLog.create({ businessId, userId: user._id, action: 'settings.etims.update', entityType: 'IntegrationSettings', entityId: settings._id, newValue: { changedFields: changed } });
  return getStatus(businessId);
}

/** "Test connection" buttons - real calls against the provider, no state changes. */
async function testMpesa(businessId, user) {
  assertOwner(user);
  const settings = await IntegrationSettings.findOne({ businessId }).select('+mpesa.credentialsBlob');
  if (!settings?.mpesa?.credentialsBlob) throw ApiError.badRequest('No M-PESA credentials saved yet', 'MPESA_NOT_CONFIGURED');
  const { decryptJson } = require('../utils/crypto');
  // A cheap read-only call: query a bogus reference. A 401/403 means bad
  // credentials; a 404/"not found" body means auth succeeded.
  try {
    await payhero.getTransactionStatus({ credentials: decryptJson(settings.mpesa.credentialsBlob), reference: 'connection-test' });
    return { ok: true, message: 'PayHero credentials accepted' };
  } catch (err) {
    if (err.code === 'MPESA_STATUS_CHECK_FAILED' && !/unauthor/i.test(err.message)) {
      return { ok: true, message: 'PayHero credentials accepted' }; // reached the API, just no such reference
    }
    return { ok: false, message: err.message };
  }
}

async function testEtims(businessId, user) {
  assertOwner(user);
  const settings = await IntegrationSettings.findOne({ businessId }).select('+etims.credentialsBlob');
  if (!settings?.etims?.credentialsBlob) throw ApiError.badRequest('No eTIMS credentials saved yet', 'ETIMS_NOT_CONFIGURED');
  const { decryptJson } = require('../utils/crypto');
  try {
    await digitax.getInvoiceStatus(settings.etims.environment, { ...decryptJson(settings.etims.credentialsBlob), kraPin: settings.etims.kraPin }, 'connection-test');
    return { ok: true, message: 'DigiTax credentials accepted' };
  } catch (err) {
    return { ok: /not.?found/i.test(err.message), message: err.message };
  }
}

module.exports = { getStatus, getFlagsForPos, updateMpesa, updateEtims, testMpesa, testEtims };