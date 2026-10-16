'use strict';
/**
 * businessContext.js - "what country / currency / language is this business?" in one cached lookup.
 *
 * Used by code that formats money or text for a business but only has a businessId (notifications,
 * invoices, CRM, SMS...). Legacy businesses have no countryCode and resolve to Kenya / KES / English,
 * so nothing changes for them. The 30s cache is invalidated whenever the business is edited here.
 */
const Business = require('../models/Business');
const { getCountry, toCountryCode, normalizeLanguage, DEFAULT_COUNTRY } = require('../constants/countries');
const { moneyFormatter } = require('./currency');

const TTL_MS = 30 * 1000;
const cache = new Map();

function build(b) {
  const code = toCountryCode(b && b.countryCode) || toCountryCode(b && b.country) || DEFAULT_COUNTRY;
  const country = getCountry(code);
  // Legacy businesses have no language stored and stay English.
  const lang = normalizeLanguage(b && b.language, 'en');
  const currency = (b && b.currency) || country.currency;
  return {
    countryCode: country.code,
    country,
    currency,
    language: lang,
    timezone: (b && b.timezone) || country.timezone,
    fmt: moneyFormatter(currency, lang),
  };
}

async function getBusinessContext(businessId) {
  const key = String(businessId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ctx;
  const b = await Business.findById(businessId).select('country countryCode currency language timezone').lean();
  const ctx = build(b);
  cache.set(key, { at: Date.now(), ctx });
  return ctx;
}

function invalidateBusinessContext(businessId) {
  if (businessId) cache.delete(String(businessId));
}

/** Just the country code ('KE' | 'TZ') - for phone parsing. */
async function countryCodeOf(businessId) {
  if (!businessId) return DEFAULT_COUNTRY;
  return (await getBusinessContext(businessId)).countryCode;
}

module.exports = { getBusinessContext, invalidateBusinessContext, countryCodeOf, buildContext: build };
