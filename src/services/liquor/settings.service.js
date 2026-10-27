/** Licence, trading hours, dry days and age policy. The rules here are the OWNER's: defaults are not legal advice, check your county / regulator. */
const LiquorSettings = require('../../models/LiquorSettings');
const AuditLog = require('../../models/AuditLog');
const Business = require('../../models/Business');
const { getBusinessContext } = require('../../utils/businessContext');
const { localDateTime, dowOf, toMin, fmtMin, addDays } = require('../../utils/hospitalityTime');
const { DEFAULT_MIN_AGE } = require('../../constants/liquor');
const ApiError = require('../../utils/ApiError');

async function get(businessId) {
  let s = await LiquorSettings.findOne({ businessId });
  if (!s) {
    const ctx = await getBusinessContext(businessId);
    s = await LiquorSettings.findOneAndUpdate({ businessId }, { $setOnInsert: { businessId, age: { minAge: DEFAULT_MIN_AGE[ctx.countryCode] || 18, mode: 'CONFIRM' } } }, { upsert: true, new: true });
  }
  return s;
}

function validate(input) {
  const hours = input.tradingHours && input.tradingHours.byDay;
  if (hours) {
    const seen = new Set();
    for (const d of hours) {
      if (seen.has(d.day)) throw ApiError.badRequest('A weekday is listed twice', 'INVALID_HOURS'); seen.add(d.day);
      if (!d.closed && (toMin(d.open) === null || toMin(d.close) === null)) throw ApiError.badRequest('Give opening and closing times for every open day', 'INVALID_HOURS');
    }
  }
  if (input.licence && input.licence.issuedAt && input.licence.expiresAt && new Date(input.licence.expiresAt) <= new Date(input.licence.issuedAt)) throw ApiError.badRequest('Licence expiry must be after the issue date', 'INVALID_LICENCE');
}

async function update(businessId, user, input) {
  validate(input);
  const s = await get(businessId);
  const before = { licence: s.licence, tradingHours: s.tradingHours, age: s.age, emptiesMode: s.emptiesMode };
  for (const k of ['licence', 'blockWhenLicenceExpired', 'licenceWarnDays', 'tradingHours', 'closedDates', 'age', 'maxBottlesPerSale', 'emptiesMode']) {
    if (input[k] === undefined) continue;
    if (['licence', 'tradingHours', 'age'].includes(k)) s[k] = { ...(s[k] && s[k].toObject ? s[k].toObject() : s[k]), ...input[k] }; else s[k] = input[k];
  }
  s.updatedBy = user._id; await s.save();
  await AuditLog.create({ businessId, userId: user._id, action: 'liquor.settings.update', entityType: 'LiquorSettings', entityId: s._id, oldValue: before, newValue: input });
  return s;
}

/** pure: may alcohol be sold at `at`? Returns { open, code, message, next }. */
function tradingStatus(settings, tz, at = new Date()) {
  const { ymd, minutes } = localDateTime(at, tz);
  const out = { open: true, code: 'OPEN', message: 'Open', date: ymd };
  const lic = settings.licence || {};
  if (lic.expiresAt && settings.blockWhenLicenceExpired !== false && new Date(lic.expiresAt) < at) return { ...out, open: false, code: 'LICENCE_EXPIRED', message: `The liquor licence expired on ${new Date(lic.expiresAt).toISOString().slice(0, 10)}. Renew it before selling alcohol.` };
  const dry = (settings.closedDates || []).find((d) => d.date === ymd);
  if (dry) return { ...out, open: false, code: 'DRY_DAY', message: `Alcohol sales are closed today${dry.reason ? `: ${dry.reason}` : ''}.` };
  const th = settings.tradingHours;
  if (th && th.enabled && th.byDay && th.byDay.length) {
    const win = (d) => th.byDay.find((x) => x.day === d);
    const today = win(dowOf(ymd)); const yest = win((dowOf(ymd) + 6) % 7);
    const inWindow = (w, wrapOnly) => { if (!w || w.closed) return false; const o = toMin(w.open); const c = toMin(w.close); if (c > o) return !wrapOnly && minutes >= o && minutes < c; return wrapOnly ? minutes < c : minutes >= o; };
    const ok = inWindow(today, false) || inWindow(yest, true);
    if (!ok) return { ...out, open: false, code: 'OUTSIDE_HOURS', message: today && !today.closed ? `Alcohol sales are allowed ${today.open} to ${today.close} today.` : 'Alcohol sales are closed today.' };
  }
  return out;
}

/** Everything the till and the owner dashboard need in one call. */
async function status(businessId, at = new Date()) {
  const [s, ctx] = await Promise.all([get(businessId), getBusinessContext(businessId)]);
  const t = tradingStatus(s, ctx.timezone, at);
  const lic = s.licence || {}; const days = lic.expiresAt ? Math.ceil((new Date(lic.expiresAt) - at) / 86400000) : null;
  const warnings = [];
  if (!lic.number) warnings.push({ code: 'NO_LICENCE', message: 'No liquor licence number is recorded.' });
  else if (days !== null && days < 0) warnings.push({ code: 'LICENCE_EXPIRED', message: 'The licence has expired.' });
  else if (days !== null && days <= s.licenceWarnDays) warnings.push({ code: 'LICENCE_EXPIRING', message: `The licence expires in ${days} day(s).` });
  if (!(s.tradingHours && s.tradingHours.enabled)) warnings.push({ code: 'NO_HOURS', message: 'Trading hours are not set, so alcohol can be sold at any time. Set the hours your county permits.' });
  const upcoming = (s.closedDates || []).filter((d) => d.date >= t.date && d.date <= addDays(t.date, 14)).sort((a, b) => a.date.localeCompare(b.date));
  return { trading: t, timezone: ctx.timezone, licence: { number: lic.number || null, expiresAt: lic.expiresAt || null, daysLeft: days }, minAge: s.age.minAge, ageMode: s.age.mode, emptiesMode: s.emptiesMode, upcomingClosedDates: upcoming, warnings, hoursToday: null };
}

async function isLiquorBusiness(businessId) { const b = await Business.findById(businessId).select('featureSettings').lean(); return !!(b && b.featureSettings && (b.featureSettings.liquorCompliance || b.featureSettings.ageVerification)); }

module.exports = { get, update, tradingStatus, status, isLiquorBusiness, fmtMin };
