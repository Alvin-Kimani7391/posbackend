/** Serial / IMEI helpers. IMEI = 15 digits with a Luhn check digit. */
const normalizeSerial = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');

function isValidImei(value) {
  const s = String(value);
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i += 1) {
    let d = Number(s[14 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

module.exports = { normalizeSerial, isValidImei };