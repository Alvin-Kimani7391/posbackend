/**
 * Calendar maths for stays (no database). A stay is booked in whole calendar dates ("2026-03-14") in the BUSINESS time zone;
 * the check-in / check-out times from the settings turn those dates into exact instants.
 * East Africa has no daylight saving, but the conversion below is correct for any IANA zone.
 */
const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fmtMin = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diffDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const dowOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();   // 0 = Sunday

/** The nights of a stay: check-in date up to (not including) check-out date. */
function eachNight(checkInDate, checkOutDate) {
  const out = []; const n = diffDays(checkInDate, checkOutDate);
  for (let i = 0; i < n; i += 1) out.push(addDays(checkInDate, i));
  return out;
}

function offsetMinutes(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - utcMs) / 60000);
}

/** "2026-03-14" + "14:00" in `timeZone` -> the exact Date. */
function zonedToUtc(ymd, hhmm, timeZone = 'Africa/Nairobi') {
  const mins = toMin(hhmm); if (mins === null || !ymdOk(ymd)) throw new Error('INVALID_DATE_TIME');
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(mins / 60), mins % 60);
  let t = guess - offsetMinutes(guess, timeZone) * 60000;
  t = guess - offsetMinutes(t, timeZone) * 60000;           // second pass settles zones whose offset changes near the guess
  return new Date(t);
}

/** The calendar date and minutes-since-midnight of an instant in `timeZone`. */
function localDateTime(date, timeZone = 'Africa/Nairobi') {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const todayIn = (timeZone, now = new Date()) => localDateTime(now, timeZone).ymd;

/** Do [aStart, aEnd) and [bStart, bEnd) overlap? Back-to-back (one ends exactly when the next starts) does NOT overlap. */
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

module.exports = { ymdOk, toMin, fmtMin, addDays, diffDays, dowOf, eachNight, zonedToUtc, localDateTime, todayIn, overlaps };
