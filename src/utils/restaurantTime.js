/** Timezone-aware helpers for menu periods / happy hours. The business timezone decides what "7pm Friday" means. */
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function localParts(date, timeZone = 'Africa/Nairobi') {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { dow: DOW[p.weekday], minutes: Number(p.hour) * 60 + Number(p.minute), ymd: `${p.year}${p.month}${p.day}`, isoDate: `${p.year}-${p.month}-${p.day}` };
}
const toMinutes = (hhmm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** window = { days?: [0-6], start?, end?, startDate?, endDate? }. Missing parts = always. end < start = overnight (days = day it STARTS). */
function inWindow(now, timeZone, w = {}) {
  const t = localParts(now, timeZone);
  if (w.startDate && now < new Date(w.startDate)) return false;
  if (w.endDate && now > new Date(w.endDate)) return false;
  const s = toMinutes(w.start); const e = toMinutes(w.end);
  const days = w.days && w.days.length ? w.days : null;
  if (s === null || e === null) return days ? days.includes(t.dow) : true;
  if (s <= e) return (!days || days.includes(t.dow)) && t.minutes >= s && t.minutes < e;
  if (t.minutes >= s) return !days || days.includes(t.dow);
  if (t.minutes < e) return !days || days.includes((t.dow + 6) % 7);
  return false;
}
const inAnyWindow = (now, tz, windows) => !windows || windows.length === 0 || windows.some((w) => inWindow(now, tz, w));
module.exports = { localParts, inWindow, inAnyWindow, toMinutes };
