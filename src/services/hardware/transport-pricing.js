/** Pure transport pricing. One rate per component (BASE / LOADING / OFFLOADING / WAITING / EXTRA_STOP) so a charge can never be added twice. Money = integer cents. */
const ApiError = require('../../utils/ApiError');

const spec = (rate, ctx) => { if (rate.zone && rate.zone !== ctx.zone) return -1; if (rate.vehicleType && rate.vehicleType !== ctx.vehicleType) return -1; return (rate.zone ? 2 : 0) + (rate.vehicleType ? 1 : 0); };
/** the most specific active rate for a component: zone + vehicle beats zone beats vehicle beats generic */
function pickRate(rates, component, ctx) {
  let best = null;
  for (const r of rates) { if (r.active === false || r.component !== component) continue; const s = spec(r, ctx); if (s < 0) continue; if (!best || s > best.s) best = { r, s }; }
  return best ? best.r : null;
}
function quantityFor(basis, ctx) {
  const trips = ctx.trips || 1;
  switch (basis) {
    case 'FLAT': return 1;
    case 'PER_TRIP': return trips;
    case 'PER_KM': return (ctx.distanceKm || 0) * trips;
    case 'PER_KG': return ctx.weightKg || 0;
    case 'PER_TONNE': return (ctx.weightKg || 0) / 1000;
    case 'PER_M3': return ctx.volumeM3 || 0;
    case 'PER_HOUR': return ctx.waitingHours || 0;
    case 'PER_STOP': return ctx.extraStops || 0;
    case 'PER_LOADER': return ctx.loaders || 0;
    default: return 0;
  }
}
const wanted = (component, ctx) => component === 'BASE' || (component === 'LOADING' && ctx.loading) || (component === 'OFFLOADING' && ctx.offloading) || (component === 'WAITING' && ctx.waitingHours > 0) || (component === 'EXTRA_STOP' && ctx.extraStops > 0);

/** @returns {{lines, subtotal, total, chargeToCustomer, waivedFree, negotiated, absorbed}} */
function computeCharge({ rates, ctx = {}, settings = {}, rateIds, negotiatedTotal }) {
  let chosen;
  if (rateIds && rateIds.length) {
    chosen = rateIds.map((id) => rates.find((r) => String(r._id) === String(id))).map((r, i) => { if (!r) throw ApiError.badRequest('A transport rate was not found', 'RATE_NOT_FOUND'); return r; });
    const seen = new Set();
    for (const r of chosen) { if (seen.has(r.component)) throw ApiError.badRequest(`Two ${r.component} rates were chosen. Use one, so the charge is not added twice.`, 'DUPLICATE_CHARGE'); seen.add(r.component); }
  } else {
    chosen = ['BASE', 'LOADING', 'OFFLOADING', 'WAITING', 'EXTRA_STOP'].filter((c) => wanted(c, ctx)).map((c) => pickRate(rates, c, ctx)).filter(Boolean);
  }
  const free = settings.freeDeliveryAbove > 0 && (ctx.orderValue || 0) >= settings.freeDeliveryAbove;
  const lines = [];
  for (const r of chosen) {
    const q = quantityFor(r.basis, ctx);
    if (!(q > 0)) continue;
    let amount = Math.max(Math.round(r.value * q), r.minCharge || 0);
    let note;
    if (free && r.component === 'BASE') { amount = 0; note = 'Free delivery on this order value'; }
    lines.push({ component: r.component, rateId: r._id, name: r.name, basis: r.basis, quantity: Math.round(q * 1000) / 1000, unitValue: r.value, amount, note });
  }
  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const negotiated = negotiatedTotal !== undefined && negotiatedTotal !== null;
  const total = negotiated ? negotiatedTotal : subtotal;
  const absorbed = !!(settings.absorbDelivery || ctx.absorb);
  return { lines, subtotal, total, chargeToCustomer: absorbed ? 0 : total, waivedFree: free, negotiated, absorbed };
}

/** pure: payment state of a delivery charge */
function paymentState(charge, paidTotal) {
  if (!(charge > 0)) return 'NO_CHARGE';
  if (paidTotal <= 0) return 'UNPAID';
  return paidTotal >= charge ? 'PAID' : 'PART';
}
/** pure: job profit = transport revenue - direct job costs. Revenue is what the customer is charged (0 when the business absorbs it). */
function jobProfit({ charge = 0, absorbed = false, costs = [] }) {
  const revenue = absorbed ? 0 : charge;
  const cost = costs.filter((c) => !c.voided).reduce((s, c) => s + c.amount, 0);
  return { revenue, cost, profit: revenue - cost, marginPct: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null };
}
/** pure: how much of an expense is still free to allocate to jobs, given allocations already made (so it can never be counted twice) */
const unallocated = (expenseAmount, allocations) => expenseAmount - allocations.reduce((s, a) => s + a, 0);
module.exports = { pickRate, quantityFor, computeCharge, paymentState, jobProfit, unallocated };
