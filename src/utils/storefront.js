/** Pure helpers for the business storefront (no database): distance, delivery fee, ETA, opening hours, booking slots, phones. */
const crypto = require('crypto');
const { localParts } = require('./restaurantTime');
const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const validPoint = (p) => p && Number.isFinite(num(p.lat)) && Number.isFinite(num(p.lng)) && Math.abs(num(p.lat)) <= 90 && Math.abs(num(p.lng)) <= 180;
function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 1.25 * 10) / 10;       // x1.25: roads are longer than the straight line
}
/** Fee, range and minimum order for one delivery. `from` may be missing (branch has no pin): then only the base fee applies. */
function deliveryTerms(d, { from, to, subtotalCents = 0 }) {
  const out = { ok: true, reason: null, code: null, distanceKm: null, feeCents: d.baseFeeCents || 0, minOrderCents: d.minOrderCents || 0 };
  if (validPoint(from) && validPoint(to)) {
    out.distanceKm = distanceKm({ lat: num(from.lat), lng: num(from.lng) }, { lat: num(to.lat), lng: num(to.lng) });
    if (d.maxRadiusKm > 0 && out.distanceKm > d.maxRadiusKm) return { ...out, ok: false, code: 'OUT_OF_RANGE', reason: `Sorry, we deliver within ${d.maxRadiusKm} km. You are about ${out.distanceKm} km away.` };
    out.feeCents = Math.round((d.baseFeeCents || 0) + (d.perKmCents || 0) * out.distanceKm);
  } else if (d.maxRadiusKm > 0) return { ...out, ok: false, code: 'NO_LOCATION', reason: 'Please pin your location on the map so we can check we deliver to you.' };
  if (subtotalCents && out.minOrderCents && subtotalCents < out.minOrderCents) return { ...out, ok: false, code: 'BELOW_MINIMUM', reason: `The minimum delivery order is KSh ${(out.minOrderCents / 100).toFixed(0)}.` };
  return out;
}
const etaMinutes = (d, { prepMinutes = [], distanceKm: km }) => Math.round(Math.max(0, ...prepMinutes, 0) + (d.bufferMinutes || 0) + (km || 0) * (d.minutesPerKm || 0));
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
/** Is `now` inside start..end in the business zone? No hours = always open; end < start runs past midnight. */
function withinHours(now, tz, start, end) {
  if (!start || !end) return true;
  const m = localParts(now, tz).minutes; const a = toMin(start); const b = toMin(end);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
const zonedDate = (ymd, hhmm, tz) => { // the instant when it is ymd hhmm in tz
  const guess = new Date(`${ymd}T${hhmm.padStart(5, '0')}:00Z`); const p = localParts(guess, tz);
  const diff = (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess.getTime());
  return new Date(guess.getTime() - diff);
};
function reservationSlots(ymd, { openTime = '10:00', closeTime = '22:00', slotMinutes = 30, minLeadMinutes = 30, durationMinutes = 90, timeZone, now = new Date() }) {
  const out = []; const a = toMin(openTime); const b = toMin(closeTime);
  for (let t = a; t + durationMinutes <= b + 1 && t < b; t += slotMinutes) {
    const hh = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    const startsAt = zonedDate(ymd, hh, timeZone);
    if (startsAt.getTime() >= now.getTime() + minLeadMinutes * 60000) out.push({ time: hh, startsAt });
  }
  return out;
}
function slotProblem(startsAt, { minLeadMinutes = 30, maxAdvanceDays = 30, openTime, closeTime }, { timeZone, now = new Date() }) {
  if (startsAt.getTime() < now.getTime() + minLeadMinutes * 60000) return `Please book at least ${minLeadMinutes} minutes ahead.`;
  if (startsAt.getTime() > now.getTime() + maxAdvanceDays * 86400000) return `We take bookings up to ${maxAdvanceDays} days ahead.`;
  if (!withinHours(startsAt, timeZone, openTime, closeTime)) return `We take bookings between ${openTime} and ${closeTime}.`;
  return null;
}
function kePhone(raw) {
  let d = String(raw || '').replace(/[\s\-().+]/g, ''); if (d.startsWith('254')) d = d.slice(3); if (d.startsWith('0')) d = d.slice(1);
  return /^[17]\d{8}$/.test(d) ? `254${d}` : null;
}
const last4 = (p) => String(p || '').replace(/\D/g, '').slice(-4);
const newKey = () => crypto.randomBytes(8).toString('hex');
const mapsLink = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
module.exports = { distanceKm, deliveryTerms, etaMinutes, withinHours, reservationSlots, slotProblem, kePhone, last4, newKey, mapsLink, validPoint, zonedDate };
