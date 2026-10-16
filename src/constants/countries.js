'use strict';
/**
 * countries.js - the single source of truth for everything that differs between the countries
 * the POS is sold in. A business picks its country ONCE at onboarding; currency, timezone,
 * denominations, VAT default, phone format and available integrations all follow from it.
 *
 * To add another country later: add one entry here (+ its currency in utils/currency.js) and
 * nothing else in the codebase needs to know the country by name.
 */

const LANGUAGES = Object.freeze(['en', 'sw']);

const COUNTRIES = Object.freeze({
  KE: Object.freeze({
    code: 'KE',
    name: 'Kenya',
    flag: '\u{1F1F0}\u{1F1EA}', // emoji flag; flagCode lets the app use an image (emoji flags do not render on Windows)
    flagCode: 'ke',
    dialCode: '254',
    currency: 'KES',
    timezone: 'Africa/Nairobi',
    defaultLanguage: 'en',
    languages: LANGUAGES,
    vatRate: 16,
    taxAuthority: 'KRA',
    taxIdLabel: { en: 'KRA PIN', sw: 'KRA PIN' },
    // Notes and coins a cashier counts when closing a shift (whole shillings, highest first).
    denominations: Object.freeze([1000, 500, 200, 100, 50, 40, 20, 10, 5, 1]),
    // Mobile-money rails. `integrated` = the backend can verify payments automatically.
    mobileMoney: Object.freeze([{ key: 'MPESA', label: 'M-PESA', integrated: true }]),
    integrations: Object.freeze({ mpesaPayhero: true, etims: true }),
    // Multiplier applied to money-denominated defaults that were tuned for KES (offline limits, VIP spend...).
    limitsScale: 1,
  }),
  TZ: Object.freeze({
    code: 'TZ',
    name: 'Tanzania',
    flag: '\u{1F1F9}\u{1F1FF}',
    flagCode: 'tz',
    dialCode: '255',
    currency: 'TZS',
    timezone: 'Africa/Dar_es_Salaam',
    defaultLanguage: 'sw',
    languages: LANGUAGES,
    vatRate: 18,
    taxAuthority: 'TRA',
    taxIdLabel: { en: 'TIN', sw: 'TIN' },
    // Bank of Tanzania notes: 500*, 1,000, 2,000, 5,000, 10,000 and coins 50, 100, 200, 500*.
    // (*500 exists as both a note and a coin - same value, so one counting line.)
    denominations: Object.freeze([10000, 5000, 2000, 1000, 500, 200, 100, 50]),
    mobileMoney: Object.freeze([
      { key: 'MPESA', label: 'M-Pesa (Vodacom)', integrated: false },
      { key: 'MIXX', label: 'Mixx by Yas (Tigo Pesa)', integrated: false },
      { key: 'AIRTEL', label: 'Airtel Money', integrated: false },
      { key: 'HALOPESA', label: 'HaloPesa', integrated: false },
    ]),
    // The PayHero M-PESA integration and KRA eTIMS are Kenya-only.
    integrations: Object.freeze({ mpesaPayhero: false, etims: false }),
    // ~1 KES = ~20 TZS: keeps offline caps / VIP thresholds comparable. Owners can still change them.
    limitsScale: 20,
  }),
});

const COUNTRY_CODES = Object.freeze(Object.keys(COUNTRIES));
const DEFAULT_COUNTRY = 'KE';

const NAME_TO_CODE = { kenya: 'KE', ke: 'KE', tanzania: 'TZ', tz: 'TZ', 'united republic of tanzania': 'TZ' };

/** 'TZ' | 'tz' | 'Tanzania' -> 'TZ'; anything unknown -> null. */
function toCountryCode(value) {
  if (!value) return null;
  return NAME_TO_CODE[String(value).trim().toLowerCase()] || null;
}

function getCountry(codeOrName) {
  return COUNTRIES[toCountryCode(codeOrName) || DEFAULT_COUNTRY];
}

function normalizeLanguage(lang, fallback = 'en') {
  const l = String(lang || '').toLowerCase().slice(0, 2);
  return LANGUAGES.includes(l) ? l : fallback;
}

/** Public-safe description of every supported country - served to the onboarding screen. */
function describeCountries() {
  return COUNTRY_CODES.map((code) => {
    const c = COUNTRIES[code];
    return {
      code: c.code,
      name: c.name,
      flag: c.flag,
      flagCode: c.flagCode,
      dialCode: c.dialCode,
      currency: c.currency,
      timezone: c.timezone,
      defaultLanguage: c.defaultLanguage,
      languages: c.languages,
      vatRate: c.vatRate,
      taxAuthority: c.taxAuthority,
      taxIdLabel: c.taxIdLabel,
      denominations: c.denominations,
      mobileMoney: c.mobileMoney,
      integrations: c.integrations,
    };
  });
}

module.exports = {
  COUNTRIES, COUNTRY_CODES, DEFAULT_COUNTRY, LANGUAGES,
  toCountryCode, getCountry, normalizeLanguage, describeCountries,
};
