/**
 * Phone normalisation for Kenya (254) and Tanzania (255).
 *
 * Every CRM / customer identity check uses the canonical international form without "+":
 *   Kenya     2547XXXXXXXX / 2541XXXXXXXX
 *   Tanzania  2556XXXXXXXX / 2557XXXXXXXX
 * so "0712 345 678", "+254712345678" and "712345678" all resolve to the same customer.
 *
 * IMPORTANT: a local number such as 0712345678 is valid in BOTH countries, so local formats can only
 * be interpreted when the business's country is known. Pass `country` ('KE' | 'TZ') whenever you
 * have it. With no country the legacy behaviour applies (local numbers are read as Kenyan, and
 * international 255... numbers are accepted as Tanzanian) - existing Kenyan data is unaffected.
 */

const RULES = {
  KE: { dial: '254', intl: /^254[17]\d{8}$/, local: /^0[17]\d{8}$/, bare: /^[17]\d{8}$/, typo: /^2540[17]\d{8}$/ },
  TZ: { dial: '255', intl: /^255[67]\d{8}$/, local: /^0[67]\d{8}$/, bare: /^[67]\d{8}$/, typo: /^2550[67]\d{8}$/ },
};

function clean(raw) {
  if (raw === undefined || raw === null) return null;
  let d = String(raw).trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}

function normalizeFor(d, country) {
  const r = RULES[country];
  if (!r) return null;
  if (r.typo.test(d)) d = r.dial + d.slice(r.dial.length + 1); // "2540712..." typo -> "254712..."
  if (r.local.test(d)) d = r.dial + d.slice(1);
  else if (r.bare.test(d)) d = r.dial + d;
  return r.intl.test(d) ? d : null;
}

function normalizePhone(raw, country) {
  const d = clean(raw);
  if (d === null) return null;
  if (country && RULES[country]) return normalizeFor(d, country);
  return normalizeFor(d, 'KE') || (RULES.TZ.intl.test(d) ? d : null);
}

/** 254712345678 -> 0712345678 (what cashiers are used to seeing). Both dial codes are 3 digits. */
function toLocalPhone(normalized) {
  return normalized ? '0' + String(normalized).slice(3) : '';
}

/** Which country does an already-normalised number belong to? */
function countryOfNormalized(n) {
  if (!n) return null;
  if (RULES.KE.intl.test(n)) return 'KE';
  if (RULES.TZ.intl.test(n)) return 'TZ';
  return null;
}

/** Is `raw` a valid mobile number for this country? */
const isValidPhone = (raw, country) => normalizePhone(raw, country) !== null;

/** The form we STORE on User.phone: Kenya keeps whatever was typed (legacy), Tanzania is always 255XXXXXXXXX. */
function phoneForStorage(raw, country) {
  const v = String(raw || '').trim();
  if (country === 'TZ') return normalizePhone(v, 'TZ') || v;
  return v;
}

/** Every value a login identifier might be stored as (raw, plus the Tanzanian canonical form). */
function loginPhoneCandidates(identifier) {
  const raw = String(identifier || '').trim();
  const out = new Set([raw]);
  const tz = normalizePhone(raw, 'TZ');
  if (tz) out.add(tz);
  return [...out];
}

module.exports = { normalizePhone, toLocalPhone, countryOfNormalized, isValidPhone, phoneForStorage, loginPhoneCandidates };
