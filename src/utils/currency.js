'use strict';
/**
 * currency.js - display helpers for the currencies we support.
 *
 * Money is ALWAYS stored as integer "cents" (minor units x100) in the business's own currency
 * (see utils/money.js). A business has exactly ONE currency, fixed by its country, so nothing is
 * ever converted and every ledger, shift and report balances in a single unit. This file only
 * deals with how an amount is SHOWN: symbol, grouping, and "amount in words" (English/Swahili).
 */

const CURRENCIES = Object.freeze({
  KES: {
    code: 'KES', symbol: 'KSh', locale: 'en-KE', minFraction: 2, maxFraction: 2,
    name: { en: ['Kenya Shilling', 'Kenya Shillings'], sw: ['shilingi ya Kenya', 'shilingi za Kenya'] },
    minor: { en: ['cent', 'cents'], sw: ['senti', 'senti'] },
  },
  TZS: {
    code: 'TZS', symbol: 'TSh', locale: 'en-TZ', minFraction: 0, maxFraction: 2,
    name: { en: ['Tanzanian Shilling', 'Tanzanian Shillings'], sw: ['shilingi ya Tanzania', 'shilingi za Tanzania'] },
    minor: { en: ['cent', 'cents'], sw: ['senti', 'senti'] },
  },
});

const getCurrency = (code) => CURRENCIES[code] || CURRENCIES.KES;

function groupLocale(cur, lang) {
  return lang === 'sw' && cur.code === 'TZS' ? 'sw-TZ' : cur.locale;
}

/** 125050 cents, 'KES' -> "KES 1,250.50"   |   1500000 cents, 'TZS' -> "TZS 15,000". Sign is kept. */
function formatMoney(cents, currency = 'KES', { lang = 'en', abs = false } = {}) {
  const cur = getCurrency(currency);
  let n = (Number(cents) || 0) / 100;
  if (abs) n = Math.abs(n);
  // Whole-shilling currencies (TZS) drop the ".00", but never hide real cents (e.g. 18% VAT on an odd price).
  const hasMinor = Math.round(Math.abs(n) * 100) % 100 !== 0;
  const minFraction = cur.minFraction === 0 && hasMinor ? 2 : cur.minFraction;
  const text = n.toLocaleString(groupLocale(cur, lang), { minimumFractionDigits: minFraction, maximumFractionDigits: cur.maxFraction });
  return `${cur.code} ${text}`;
}

/** Same thing from a decimal (major-unit) number, e.g. what the API returns. */
function formatDecimal(amount, currency = 'KES', opts = {}) {
  return formatMoney(Math.round((Number(amount) || 0) * 100), currency, opts);
}

/** A formatter bound to one business context: fmt(cents) */
function moneyFormatter(currency, lang = 'en', opts = {}) {
  return (cents) => formatMoney(cents, currency, { lang, ...opts });
}

/* ------------------------------ amount in words ------------------------------ */

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enBelow1000(n) {
  const out = [];
  if (n >= 100) { out.push(`${EN_ONES[Math.floor(n / 100)]} hundred`); n %= 100; if (n) out.push('and'); }
  if (n >= 20) out.push(EN_TENS[Math.floor(n / 10)] + (n % 10 ? `-${EN_ONES[n % 10]}` : ''));
  else if (n > 0) out.push(EN_ONES[n]);
  return out.join(' ');
}
function enInt(n) {
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, label] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) { parts.push(`${enBelow1000(Math.floor(n / size))} ${label}`); n %= size; }
  }
  if (n > 0) parts.push(n < 100 && parts.length ? `and ${enBelow1000(n)}` : enBelow1000(n));
  return parts.join(' ');
}

// Swahili: elfu (thousand), milioni, bilioni; tens/ones joined with "na". Have a native speaker
// review these once before printing them on legal invoices.
const SW_ONES = ['', 'moja', 'mbili', 'tatu', 'nne', 'tano', 'sita', 'saba', 'nane', 'tisa'];
const SW_TENS = ['', 'kumi', 'ishirini', 'thelathini', 'arobaini', 'hamsini', 'sitini', 'sabini', 'themanini', 'tisini'];

function swBelow100(n) {
  if (n < 10) return SW_ONES[n];
  const t = Math.floor(n / 10); const o = n % 10;
  return o ? `${SW_TENS[t]} na ${SW_ONES[o]}` : SW_TENS[t];
}
function swBelow1000(n) {
  const parts = [];
  const h = Math.floor(n / 100);
  if (h) parts.push(`mia ${SW_ONES[h]}`);
  if (n % 100) parts.push(swBelow100(n % 100));
  return parts.join(' na ');
}
function swInt(n) {
  if (n === 0) return 'sifuri';
  const parts = [];
  for (const [size, label] of [[1e9, 'bilioni'], [1e6, 'milioni'], [1e3, 'elfu']]) {
    if (n >= size) { parts.push(`${label} ${swBelow1000(Math.floor(n / size))}`); n %= size; }
  }
  if (n > 0) parts.push(swBelow1000(n));
  return parts.join(' na ');
}

/**
 * 125050 cents, 'KES', 'en' -> "One thousand two hundred and fifty Kenya Shillings and fifty cents only"
 * 1500000 cents, 'TZS', 'sw' -> "Elfu kumi na tano shilingi za Tanzania tu"
 */
function amountInWords(cents, currency = 'KES', lang = 'en') {
  const cur = getCurrency(currency);
  const L = lang === 'sw' ? 'sw' : 'en';
  const total = Math.max(0, Math.round(Number(cents) || 0));
  const whole = Math.floor(total / 100); const minor = total % 100;
  const [one, many] = cur.name[L];
  const unit = whole === 1 ? one : many;
  const toWords = L === 'sw' ? swInt : enInt;
  let s = `${toWords(whole)} ${unit}`;
  if (minor) s += L === 'sw' ? ` na ${cur.minor.sw[1]} ${toWords(minor)}` : ` and ${toWords(minor)} ${cur.minor.en[minor === 1 ? 0 : 1]}`;
  s += L === 'sw' ? ' tu' : ' only';
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

module.exports = { CURRENCIES, getCurrency, formatMoney, formatDecimal, moneyFormatter, amountInWords };
