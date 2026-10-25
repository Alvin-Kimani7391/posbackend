/** Pure geo helpers for rider tracking (no database). Distances are STRAIGHT-LINE metres unless a name says otherwise. */
const R_M = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const validPoint = (p) => !!p && Number.isFinite(num(p.lat)) && Number.isFinite(num(p.lng)) && Math.abs(num(p.lat)) <= 90 && Math.abs(num(p.lng)) <= 180 && !(num(p.lat) === 0 && num(p.lng) === 0);

function distanceM(a, b) {
  const la = num(a.lat); const lb = num(b.lat);
  const dLat = rad(lb - la); const dLng = rad(num(b.lng) - num(a.lng));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(la)) * Math.cos(rad(lb)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R_M * Math.asin(Math.min(1, Math.sqrt(h))));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return Math.round((deg(Math.atan2(y, x)) + 360) % 360);
}
/** Minutes to cover `m` metres. Roads are longer than the straight line (x1.25); speed is the phone's own when it is moving, else a town default. */
function etaMinutes(m, { speedMps, fallbackKmh = 20, roadFactor = 1.25 } = {}) {
  if (!(m >= 0)) return null;
  const moving = Number.isFinite(speedMps) && speedMps * 3.6 >= 8;            // below ~8 km/h the reading is noise (stopped at a junction)
  const kmh = moving ? Math.min(Math.max(speedMps * 3.6, 12), 60) : fallbackKmh;
  const mins = (m * roadFactor) / 1000 / kmh * 60;
  return m <= 30 ? 0 : Math.max(1, Math.round(mins));
}
/**
 * Which alert distances has the rider just crossed? `sent` are the ones already told. Returns { crossed, notify }:
 *   crossed  every threshold the rider is now inside (all marked as sent so a late first ping never replays 500 m, 200 m, 100 m...)
 *   notify   the single closest one to announce, or null when there is nothing new.
 */
function crossedAlerts(distance, thresholds, sent = []) {
  const done = new Set((sent || []).map(Number));
  const inside = [...thresholds].map(Number).filter((t) => distance <= t).sort((a, b) => b - a);
  const fresh = inside.filter((t) => !done.has(t));
  return { crossed: fresh, notify: fresh.length ? fresh[fresh.length - 1] : null };
}
/** Keeps at most `max` points of a route line, always the first and the last. */
function decimate(points, max = 120) {
  if (!Array.isArray(points) || points.length <= max) return points || [];
  const step = (points.length - 1) / (max - 1); const out = [];
  for (let i = 0; i < max; i += 1) out.push(points[Math.round(i * step)]);
  return out;
}
const fmtDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(0, Math.round(m / 10) * 10)} m`);
module.exports = { distanceM, bearing, etaMinutes, crossedAlerts, decimate, validPoint, fmtDistance, num };
