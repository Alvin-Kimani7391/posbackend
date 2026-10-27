/** "May THIS business use THIS add-on now?" Add-on not in catalogue / not active / other business type => FREE (not locked). */
const BillingAddon = require('../models/BillingAddon');
const BusinessAddon = require('../models/BusinessAddon');
const Business = require('../models/Business');
const ApiError = require('../utils/ApiError');
const { DEFAULT_GRACE_DAYS } = require('../constants/addons');
const DAY = 24 * 3600 * 1000; const TTL = 15 * 1000;
const catCache = { at: 0, list: [] }; const bizCache = new Map();
const invalidateCatalog = () => { catCache.at = 0; bizCache.clear(); };
const invalidateBusiness = (id) => bizCache.delete(String(id));
async function activeCatalog() {
  if (Date.now() - catCache.at < TTL) return catCache.list;
  catCache.list = await BillingAddon.find({ isActive: true }).sort({ sortOrder: 1 }).lean(); catCache.at = Date.now();
  return catCache.list;
}
const applies = (addon, type) => !addon.businessTypes?.length || addon.businessTypes.includes(type);
function evaluate(ba, addon, now = new Date()) {
  if (!ba) return { entitled: false, reason: 'NOT_SUBSCRIBED', until: null };
  if (ba.complimentary && (!ba.complimentaryUntil || ba.complimentaryUntil >= now)) return { entitled: true, reason: 'COMPLIMENTARY', until: ba.complimentaryUntil || null };
  if (ba.status === 'ACTIVE' && ba.currentPeriodEnd) {
    const grace = (addon && addon.graceDays != null ? addon.graceDays : DEFAULT_GRACE_DAYS) * DAY;
    const end = new Date(ba.currentPeriodEnd).getTime();
    if (now.getTime() <= end) return { entitled: true, reason: ba.isTrial ? 'TRIAL' : 'PAID', until: ba.currentPeriodEnd };
    if (!ba.cancelAtPeriodEnd && now.getTime() <= end + grace) return { entitled: true, reason: 'GRACE', until: new Date(end + grace) };
  }
  return { entitled: false, reason: ba.status === 'PENDING_PAYMENT' ? 'PENDING_PAYMENT' : 'EXPIRED', until: null };
}
async function entitlementsFor(businessId) {
  const hit = bizCache.get(String(businessId));
  if (hit && hit.exp > Date.now()) return hit.v;
  const [catalog, business, owned] = await Promise.all([activeCatalog(), Business.findById(businessId).select('businessType').lean(), BusinessAddon.find({ businessId }).lean()]);
  const map = {};
  if (business) {
    const byKey = new Map(owned.map((o) => [o.addonKey, o]));
    for (const a of catalog) if (applies(a, business.businessType)) map[a.key] = { ...evaluate(byKey.get(a.key), a), name: a.name };
  }
  if (bizCache.size > 3000) bizCache.clear();
  bizCache.set(String(businessId), { v: map, exp: Date.now() + TTL });
  return map;
}
async function assertEntitled(businessId, ...keys) {
  const map = await entitlementsFor(businessId);
  for (const k of keys) {
    const e = map[String(k).toLowerCase()];
    if (e && !e.entitled) throw new ApiError(402, `${e.name} is a premium feature. Upgrade your plan to use it.`, 'PREMIUM_REQUIRED', [{ addonKey: String(k).toLowerCase(), name: e.name, reason: e.reason }]);
  }
  return true;
}
module.exports = { evaluate, entitlementsFor, assertEntitled, activeCatalog, applies, invalidateCatalog, invalidateBusiness };
