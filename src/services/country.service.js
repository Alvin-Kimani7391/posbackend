'use strict';
/**
 * country.service.js - everything that depends on the business's country in one place:
 *   - defaults a NEW business gets (VAT rate, payment methods, offline caps scaled to the currency)
 *   - the guarded "I picked the wrong country" switch (only while the business holds no money data)
 */
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { getCountry, toCountryCode, normalizeLanguage } = require('../constants/countries');
const { invalidateBusinessContext } = require('../utils/businessContext');

const KES_OFFLINE_DEFAULTS = { maxPendingValueCents: 20000000, maxManualMpesaCents: 5000000 };
const KES_VIP_DEFAULT_CENTS = 2000000;

/** Business fields that depend on the country. Spread into Business.create(). */
function buildBusinessDefaults(countryCodeOrName, language) {
  const c = getCountry(countryCodeOrName);
  const scale = c.limitsScale || 1;
  const kenya = c.integrations.mpesaPayhero;
  return {
    countryCode: c.code,
    country: c.name,
    currency: c.currency,
    timezone: c.timezone,
    language: normalizeLanguage(language, c.defaultLanguage),
    taxSettings: { taxInclusive: true, defaultTaxRate: c.vatRate },
    paymentSettings: { acceptCash: true, acceptMpesa: kenya, acceptMobileMoney: !kenya },
    settings: {
      offline: {
        maxPendingValueCents: KES_OFFLINE_DEFAULTS.maxPendingValueCents * scale,
        maxManualMpesaCents: KES_OFFLINE_DEFAULTS.maxManualMpesaCents * scale,
      },
    },
  };
}

/** Default CRM "VIP spend" threshold in the business's currency (KES 20,000 ~ TZS 400,000). */
function vipDefaultCents(countryCode) {
  return KES_VIP_DEFAULT_CENTS * (getCountry(countryCode).limitsScale || 1);
}

/**
 * Switch a business's country. Allowed ONLY while the business holds no money data: every stored amount is an
 * integer in the business's single currency, so changing currency under existing prices/sales/shifts would silently
 * relabel KES 1,000 as TZS 1,000 and unbalance the books. Otherwise refuse with COUNTRY_LOCKED.
 */
async function changeCountry(businessId, userId, { countryCode, language }) {
  const code = toCountryCode(countryCode);
  if (!code) throw ApiError.badRequest('Choose Kenya or Tanzania', 'INVALID_COUNTRY');

  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');
  if (business.countryCode === code) {
    // Choosing the country the business already has just CONFIRMS it (the one-time prompt for pre-Tanzania accounts).
    if (!business.countryConfirmed || (language && language !== business.language)) {
      business.countryConfirmed = true;
      if (language) business.language = normalizeLanguage(language, business.language);
      await business.save();
      invalidateBusinessContext(businessId);
      await AuditLog.create({ businessId, userId, action: 'business.country.confirm', entityType: 'Business', entityId: business._id, newValue: { countryCode: code } });
    }
    return business;
  }

  const models = ['Sale', 'Payment', 'CashShift', 'Purchase', 'Expense', 'Refund', 'Product', 'SupplierPayment', 'JobCard', 'RepairJob'];
  const counts = await Promise.all(models.map((m) => require(`../models/${m}`).countDocuments({ businessId })));
  const used = models.filter((_, i) => counts[i] > 0);
  if (used.length) {
    throw ApiError.conflict(
      `The country cannot be changed because this business already has ${used.join(', ')} recorded in ${business.currency}. Contact support.`,
      'COUNTRY_LOCKED'
    );
  }

  // Subscription invoices/payments are also in the business's currency: once any exist the currency is locked.
  const [subInvoices, subPayments] = await Promise.all([
    require('../models/Invoice').countDocuments({ businessId }),
    require('../models/SubscriptionPayment').countDocuments({ businessId }),
  ]);
  if (subInvoices || subPayments) {
    throw ApiError.conflict(
      `The country cannot be changed because this business already has subscription invoices or payments in ${business.currency}. Contact support.`,
      'COUNTRY_LOCKED_BILLING'
    );
  }

  const old = { countryCode: business.countryCode, currency: business.currency };
  const d = buildBusinessDefaults(code, language);
  business.$locals.allowCountryChange = true;
  business.countryCode = d.countryCode;
  business.countryConfirmed = true;
  business.country = d.country;
  business.currency = d.currency;
  business.timezone = d.timezone;
  business.language = d.language;
  business.taxSettings.defaultTaxRate = d.taxSettings.defaultTaxRate;
  business.paymentSettings.acceptMpesa = d.paymentSettings.acceptMpesa;
  business.paymentSettings.acceptMobileMoney = d.paymentSettings.acceptMobileMoney;
  business.settings.offline.maxPendingValueCents = d.settings.offline.maxPendingValueCents;
  business.settings.offline.maxManualMpesaCents = d.settings.offline.maxManualMpesaCents;
  await business.save();
  invalidateBusinessContext(businessId);
  // Move the (not yet invoiced) subscription onto the plan of the new currency, keeping the trial clock.
  await require('./billing.service').switchCurrency(businessId, d.currency)
    .catch((e) => console.error('[billing] currency switch failed', e.message));

  await AuditLog.create({
    businessId, userId, action: 'business.country.change', entityType: 'Business', entityId: business._id,
    oldValue: old, newValue: { countryCode: code, currency: d.currency },
  });
  return business;
}

module.exports = { buildBusinessDefaults, vipDefaultCents, changeCountry };
