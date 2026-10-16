'use strict';
/**
 * Tiny i18n layer (English / Kiswahili), no dependency.  t('sw', 'shift.opened.titleMgmt', { name: 'Asha' })
 * Missing Swahili keys fall back to English, then to the key itself - a missing translation never breaks a response.
 */
const en = require('./en');
const sw = require('./sw');
const { normalizeLanguage } = require('../constants/countries');
const CATALOGS = { en, sw };

const lookup = (catalog, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), catalog);
const fill = (template, params) => String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => (params && params[k] !== undefined && params[k] !== null ? String(params[k]) : ''));

function t(lang, key, params = {}) {
  const found = lookup(CATALOGS[normalizeLanguage(lang)], key);
  const value = typeof found === 'string' ? found : lookup(CATALOGS.en, key);
  return typeof value === 'string' ? fill(value, params) : key;
}
function errorMessage(lang, code) {
  const l = normalizeLanguage(lang);
  if (l === 'en') return null;
  const v = CATALOGS[l].errors[code];
  return typeof v === 'string' ? v : null;
}
function successMessage(lang, message) {
  const l = normalizeLanguage(lang);
  if (l === 'en') return message;
  return CATALOGS[l].success[message] || message;
}
function methodLabel(lang, method) {
  const v = lookup(CATALOGS[normalizeLanguage(lang)], `paymentMethod.${method}`);
  if (typeof v === 'string') return v;
  const e = lookup(CATALOGS.en, `paymentMethod.${method}`);
  return typeof e === 'string' ? e : String(method || '').replace(/_/g, ' ').toLowerCase();
}
module.exports = { t, errorMessage, successMessage, methodLabel, normalizeLanguage };
