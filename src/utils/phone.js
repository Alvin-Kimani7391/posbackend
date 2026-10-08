/**
 * Kenyan phone normalisation. Every CRM identity check uses the canonical form
 * 2547XXXXXXXX / 2541XXXXXXXX, so "0712 345 678", "+254712345678" and
 * "712345678" all resolve to the same customer.
 * Returns null when the input is not a valid Kenyan mobile number
 * (this also safely rejects the hashed/masked MSISDNs Safaricom sends on some till payments).
 */
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return null;
  let d = String(raw).trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d+$/.test(d)) return null;
  d = d.replace(/^\+/, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^2540[17]\d{8}$/.test(d)) d = '254' + d.slice(4); // "2540712..." typo -> "254712..."
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^254[17]\d{8}$/.test(d) ? d : null;
}

/** 254712345678 -> 0712345678 (what cashiers are used to seeing) */
function toLocalPhone(normalized) {
  return normalized ? '0' + String(normalized).slice(3) : '';
}

module.exports = { normalizePhone, toLocalPhone };