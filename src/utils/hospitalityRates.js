/**
 * Room pricing, early / late fees, cancellation and deposit rules (no database). All money is integer cents.
 * The owner's settings decide everything; nothing here has a built-in business rule except the arithmetic.
 */
const T = require('./hospitalityTime');
const { lineMath } = require('./restaurantBilling');

const fail = (code, message) => { const e = new Error(message || code); e.code = code; return e; };
const pct = (cents, percent) => Math.round((cents * percent) / 100);

/** Rate for one night: a matching seasonal rate wins, then the weekend rate, then the base rate. */
function nightRate(roomType, ymd) {
  const dow = T.dowOf(ymd);
  const season = (roomType.seasonalRates || []).find((s) => ymd >= s.startDate && ymd <= s.endDate && (!s.days || !s.days.length || s.days.includes(dow)));
  if (season) return { amount: season.rate, label: season.name || 'Seasonal' };
  if (roomType.weekendRate !== undefined && roomType.weekendRate !== null && (roomType.weekendDays || []).includes(dow)) return { amount: roomType.weekendRate, label: 'Weekend' };
  return { amount: roomType.baseRate, label: 'Standard' };
}

/**
 * Prices a stay. Returns the room charge per night plus the extra lines (extra adults, children, meal plan) so the
 * invoice can show them separately. `overrideNightly` (cents) replaces the room rate for every night.
 */
function priceStay(roomType, { checkInDate, checkOutDate, adults = 1, children = 0, mealPlan = 'ROOM_ONLY', overrideNightly, dayUse = false, dayUsePercent = 100 }) {
  if (!T.ymdOk(checkInDate) || !T.ymdOk(checkOutDate)) throw fail('INVALID_DATE', 'Dates must look like 2026-03-14');
  const nights = dayUse ? [checkInDate] : T.eachNight(checkInDate, checkOutDate);
  if (!nights.length) throw fail('INVALID_DATES', 'Check-out must be after check-in');
  if (adults > roomType.maxAdults) throw fail('TOO_MANY_ADULTS', `This room takes at most ${roomType.maxAdults} adult(s)`);
  if (children > roomType.maxChildren) throw fail('TOO_MANY_CHILDREN', `This room takes at most ${roomType.maxChildren} child(ren)`);
  const factor = dayUse ? dayUsePercent / 100 : 1;
  const nightly = nights.map((date) => {
    const base = nightRate(roomType, date);
    const amount = overrideNightly !== undefined && overrideNightly !== null ? overrideNightly : base.amount;
    return { date, amount: Math.round(amount * factor), label: overrideNightly !== undefined && overrideNightly !== null ? 'Negotiated' : (dayUse ? `${base.label} (day use)` : base.label) };
  });
  const extras = [];
  const extraAdults = Math.max(0, adults - (roomType.baseOccupancy || 1));
  if (extraAdults && roomType.extraAdultRate) extras.push({ type: 'EXTRA_PERSON', description: `Extra adult x${extraAdults}`, quantity: nights.length * extraAdults, unitPrice: Math.round(roomType.extraAdultRate * factor) });
  if (children && roomType.childRate) extras.push({ type: 'EXTRA_PERSON', description: `Child x${children}`, quantity: nights.length * children, unitPrice: Math.round(roomType.childRate * factor) });
  const mp = mealPlan && mealPlan !== 'ROOM_ONLY' ? (roomType.mealPlanPrices instanceof Map ? roomType.mealPlanPrices.get(mealPlan) : (roomType.mealPlanPrices || {})[mealPlan]) : 0;
  if (mp) extras.push({ type: 'FNB', description: `${mealPlan.replace(/_/g, ' ').toLowerCase()} x${adults}`, quantity: nights.length * adults, unitPrice: mp });
  const total = nightly.reduce((s, n) => s + n.amount, 0) + extras.reduce((s, e) => s + e.quantity * e.unitPrice, 0);
  return { nights: nights.length, nightly, extras, total };
}

/** One fee rule applied to an amount. `hours` is only used by HOURLY rules. */
function applyFee(rule, nightAmount, hours = 0) {
  switch (rule.feeType) {
    case 'FLAT': return rule.value || 0;
    case 'PERCENT': return pct(nightAmount, rule.value || 0);
    case 'HOURLY': return Math.round((rule.value || 0) * Math.max(0, Math.ceil(hours)));
    case 'FULL_NIGHT': return nightAmount;
    default: return 0;
  }
}

/**
 * Arrival before the standard check-in time. `arrivalMin` / `standardMin` are minutes since midnight on the arrival date.
 * Returns { applies, denied, fee, label }. Arrival at or after the standard time costs nothing.
 */
function earlyCheckInFee(settings, { arrivalMin, standardMin, nightAmount }) {
  const e = settings.earlyCheckIn || {};
  if (arrivalMin >= standardMin) return { applies: false, denied: false, fee: 0 };
  if (e.allowed === false) return { applies: true, denied: true, fee: 0, label: 'Early check-in is not offered' };
  const tiers = [...(e.tiers || [])].map((t) => ({ ...t, m: T.toMin(t.from) })).filter((t) => t.m !== null).sort((a, b) => b.m - a.m);
  const tier = tiers.find((t) => arrivalMin >= t.m);
  if (tier) { const fee = applyFee(tier, nightAmount, (standardMin - arrivalMin) / 60); return { applies: fee > 0, denied: false, fee, label: `Early check-in from ${tier.from}` }; }
  if (e.beforeFirstTier === 'DENY') return { applies: true, denied: true, fee: 0, label: 'Too early to check in' };
  return { applies: true, denied: false, fee: nightAmount, label: 'Early check-in (previous night)' };
}

/** Departure after the standard check-out time. `departMin` is minutes since midnight on the departure date. */
function lateCheckOutFee(settings, { departMin, standardMin, nightAmount }) {
  const l = settings.lateCheckOut || {};
  const grace = l.graceMinutes ?? 0;
  if (departMin <= standardMin + grace) return { applies: false, denied: false, fee: 0 };
  if (l.allowed === false) return { applies: true, denied: true, fee: nightAmount, label: 'Late check-out is not offered' };
  const tiers = [...(l.tiers || [])].map((t) => ({ ...t, m: T.toMin(t.until) })).filter((t) => t.m !== null).sort((a, b) => a.m - b.m);
  const tier = tiers.find((t) => departMin <= t.m);
  if (tier) { const fee = applyFee(tier, nightAmount, (departMin - standardMin) / 60); return { applies: fee > 0, denied: false, fee, label: `Late check-out until ${tier.until}` }; }
  if (l.afterLastTier === 'DENY') return { applies: true, denied: true, fee: nightAmount, label: 'Past the latest allowed check-out' };
  return { applies: true, denied: false, fee: nightAmount, label: 'Late check-out (extra night)' };
}

/** Fee for cancelling. Free when made at least `freeUntilHours` before the expected check-in. */
function cancellationFee(settings, { expectedCheckIn, now = new Date(), firstNightAmount, total }) {
  const c = settings.cancellation || {};
  const hoursLeft = (new Date(expectedCheckIn) - now) / 3600000;
  if (hoursLeft >= (c.freeUntilHours ?? 24)) return { fee: 0, free: true };
  let fee = 0;
  if (c.penaltyType === 'FIRST_NIGHT') fee = firstNightAmount;
  else if (c.penaltyType === 'PERCENT') fee = pct(total, c.value || 0);
  else if (c.penaltyType === 'FLAT') fee = c.value || 0;
  return { fee: Math.min(fee, total), free: false };
}

/** Deposit the owner wants for a booking. */
function depositDue(settings, { firstNightAmount, total }) {
  const d = settings.deposit || {};
  if (!d.required) return 0;
  const raw = d.type === 'FLAT' ? (d.value || 0) : d.type === 'PERCENT' ? pct(total, d.value || 0) : firstNightAmount;
  return Math.min(raw, total);
}

/** Folio line maths in the business's tax mode. */
function folioLineAmounts(quantity, unitPrice, taxRate, taxInclusive) {
  const gross = Math.round(quantity * unitPrice);
  const { taxAmount, total } = lineMath(gross, 0, taxRate || 0, taxInclusive);
  return { gross, taxAmount, total };
}

/** Levies are a percentage of the room charge before tax and are added on top. Returns the lines to post. */
function levyAmounts(levies, roomNetCents, taxInclusive) {
  return (levies || []).filter((l) => l.percent > 0).map((l) => {
    const unit = pct(roomNetCents, l.percent);
    return { name: l.name, taxRate: l.taxRate || 0, unitPrice: unit, ...folioLineAmounts(1, unit, l.taxRate || 0, taxInclusive) };
  });
}

/** Totals of a folio. Voided lines are ignored. paid/credit/waived come from the stay's payments. */
function folioTotals(lines, payments = [], { credit = 0, waived = 0 } = {}) {
  const live = lines.filter((l) => !l.voided);
  const charges = live.reduce((s, l) => s + l.total, 0);
  const tax = live.reduce((s, l) => s + l.taxAmount, 0);
  const paid = payments.reduce((s, p) => (p.kind === 'REFUND' ? s - p.amount : s + p.amount), 0);
  return { charges, tax, paid, credit, waived, balance: charges - paid - credit - waived };
}

module.exports = { nightRate, priceStay, applyFee, earlyCheckInFee, lateCheckOutFee, cancellationFee, depositDue, folioLineAmounts, levyAmounts, folioTotals, fail };
