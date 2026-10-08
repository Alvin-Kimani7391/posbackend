const DAY = 86400000;
const HOUR = 3600000;

const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY);

/** Calendar-month add (UTC) that clamps the day (31 Jan + 1 month = 28/29 Feb). Always add from the ANCHOR date to avoid drift. */
function addMonths(date, n) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

const floorShilling = (cents) => Math.floor(cents / 100) * 100;

/** Start of the current month in Nairobi time (UTC+3, no DST). */
function monthStartEAT(now = new Date()) {
  const t = new Date(now.getTime() + 3 * HOUR);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) - 3 * HOUR);
}

module.exports = { DAY, HOUR, addDays, addMonths, floorShilling, monthStartEAT };