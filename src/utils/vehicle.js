/** Number plates are compared without spaces/dashes/case: "kdg 123a" == "KDG-123A". */
function normalizePlate(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** VIN: 17 chars, no I, O or Q. Returns uppercase VIN or null when it is not a valid shape. */
function normalizeVin(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s : null;
}

module.exports = { normalizePlate, normalizeVin };