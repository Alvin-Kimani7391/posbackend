/** Expiry is by calendar day (UTC, same rule as product batches): a batch is usable THROUGH its expiry date and expires the next day. */
const DAY = 86400000;
const startOfToday = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const startOfDay = (d) => startOfToday(new Date(d));
const sameDay = (a, b) => startOfDay(a).getTime() === startOfDay(b).getTime();
const isExpired = (expiryDate, now = new Date()) => !!expiryDate && new Date(expiryDate) < startOfToday(now);
const daysLeft = (expiryDate, now = new Date()) => (expiryDate ? Math.round((startOfDay(expiryDate).getTime() - startOfToday(now).getTime()) / DAY) : null);
module.exports = { DAY, startOfToday, startOfDay, sameDay, isExpired, daysLeft };
