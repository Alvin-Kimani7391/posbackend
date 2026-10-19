/**
 * Restaurant time helpers (no database). Everything is calculated in the BUSINESS time zone
 * (default Africa/Nairobi), never in the server's own zone (Render runs in UTC).
 *
 *  - localParts(date, timeZone) -> { ymd, date, year, month, day, hour, minute, minutes, dow }
 *        ymd  = compact "20261018" (used in ticket / pickup numbers and daily counters)
 *        date = "2026-10-18"
 *        dow  = 0 (Sunday) .. 6 (Saturday)
 *  - inAnyWindow(now, timeZone, windows) -> is `now` inside at least one window?
 *        window = { days: [0-6], start: 'HH:MM', end: 'HH:MM', startDate, endDate }
 *        - no windows at all  -> true (nothing restricts it)
 *        - no days            -> every day
 *        - no start / end     -> all day
 *        - end earlier than start (e.g. 22:00 -> 02:00) -> runs past midnight into the next day
 *        - startDate / endDate (inclusive) limit a promotion to a date range
 */
const DEFAULT_TZ = 'Africa/Nairobi';
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function safeZone(timeZone) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: timeZone || DEFAULT_TZ }); return timeZone || DEFAULT_TZ; } catch { return DEFAULT_TZ; }
}

function localParts(date = new Date(), timeZone = DEFAULT_TZ) {
  const d = date instanceof Date ? date : new Date(date);
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: safeZone(timeZone), hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const hour = Number(p.hour); const minute = Number(p.minute);
  return {
    ymd: `${p.year}${p.month}${p.day}`,
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour, minute, minutes: hour * 60 + minute,
    dow: DOW[p.weekday] ?? 0,
  };
}

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const ymdOf = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

function inWindow(now, timeZone, w) {
  if (!w) return true;
  const t = localParts(now, timeZone);
  const days = Array.isArray(w.days) ? w.days : [];
  const start = toMin(w.start); const end = toMin(w.end);
  const overnight = start !== null && end !== null && end < start;

  // Which calendar day does this moment "belong" to? After midnight inside an overnight window it is still yesterday's window.
  let dow = t.dow; let dateStr = t.date;
  if (overnight && t.minutes < end) {
    dow = (t.dow + 6) % 7;
    const prev = new Date(`${t.date}T00:00:00Z`); prev.setUTCDate(prev.getUTCDate() - 1);
    dateStr = prev.toISOString().slice(0, 10);
  }
  if (days.length && !days.includes(dow)) return false;

  const from = ymdOf(w.startDate); const to = ymdOf(w.endDate);
  if (from && dateStr < from) return false;
  if (to && dateStr > to) return false;

  if (start === null && end === null) return true;
  const s = start ?? 0; const e = end ?? 1440;
  if (overnight) return t.minutes >= s || t.minutes < e;
  return t.minutes >= s && t.minutes < e;
}

function inAnyWindow(now, timeZone, windows) {
  if (!Array.isArray(windows) || windows.length === 0) return true;
  return windows.some((w) => inWindow(now, timeZone, w));
}

module.exports = { localParts, inWindow, inAnyWindow, DEFAULT_TZ };
