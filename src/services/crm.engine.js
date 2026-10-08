/**
 * crm.engine.js - pure functions, no DB access.
 *   classify()        : stats + thresholds -> lifecycle label
 *   buildRuleFilter() : segment rules      -> Mongo filter on Customer
 *   systemSegments()  : built-in segments (thresholds-aware)
 */
const DAY = 24 * 60 * 60 * 1000;

const LIFECYCLES = ['prospect', 'new', 'returning', 'frequent', 'vip', 'inactive'];

const DEFAULT_SETTINGS = {
  newWindowDays: 30,
  inactiveDays: 60,
  frequentMinPurchases: 4,
  frequentWindowDays: 30,
  vipMinSpendCents: 2000000,
  vipMinPurchases: 0,
};

/**
 * Priority (first match wins):
 *   prospect  - in the book, never bought
 *   inactive  - last purchase older than inactiveDays (a lapsed VIP is a win-back target, so this beats VIP;
 *               `isVip` stays true so segments can still target "lapsed VIPs")
 *   vip       - net spend >= vipMinSpendCents OR purchases >= vipMinPurchases
 *   frequent  - >= frequentMinPurchases inside frequentWindowDays
 *   returning - 2+ purchases
 *   new       - exactly 1 purchase
 */
function classify(stats, settings, now = new Date()) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const count = stats.purchaseCount || 0;
  if (!count) return { lifecycle: 'prospect', isVip: false };

  const net = Math.max(0, stats.totalSpentCents || 0);
  const isVip =
    (s.vipMinSpendCents > 0 && net >= s.vipMinSpendCents) ||
    (s.vipMinPurchases > 0 && count >= s.vipMinPurchases);

  const idleDays = stats.lastPurchaseAt ? (now - new Date(stats.lastPurchaseAt)) / DAY : Infinity;

  let lifecycle;
  if (idleDays > s.inactiveDays) lifecycle = 'inactive';
  else if (isVip) lifecycle = 'vip';
  else if ((stats.recentPurchases || 0) >= s.frequentMinPurchases) lifecycle = 'frequent';
  else if (count >= 2) lifecycle = 'returning';
  else lifecycle = 'new';

  return { lifecycle, isVip };
}

/* ------------------------------ segment rules ------------------------------ */

const FIELDS = {
  lifecycle: { path: 'crm.lifecycle', type: 'enum' },
  totalSpent: { path: 'crm.totalSpentCents', type: 'money' }, // rule value is in KES
  purchaseCount: { path: 'crm.purchaseCount', type: 'number' },
  avgOrder: { path: 'crm.avgOrderCents', type: 'money' },
  recentPurchases: { path: 'crm.recentPurchases', type: 'number' },
  lastPurchaseDays: { path: 'crm.lastPurchaseAt', type: 'daysAgo' },
  customerSinceDays: { path: 'createdAt', type: 'daysAgo' },
  category: { path: 'crm.topCategories.name', type: 'text' },
  paymentMethod: { path: 'crm.paymentMethods', type: 'text' },
  tag: { path: 'tags', type: 'text' },
  hasPhone: { path: 'phoneNormalized', type: 'bool' },
  source: { path: 'source', type: 'enum' },
};
const FIELD_KEYS = Object.keys(FIELDS);
const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'contains'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function numericClause(path, op, a, b) {
  if (Number.isNaN(a)) return null;
  switch (op) {
    case 'eq': return { [path]: a };
    case 'neq': return { [path]: { $ne: a } };
    case 'gt': return { [path]: { $gt: a } };
    case 'gte': return { [path]: { $gte: a } };
    case 'lt': return { [path]: { $lt: a } };
    case 'lte': return { [path]: { $lte: a } };
    case 'between': return Number.isNaN(b) ? null : { [path]: { $gte: Math.min(a, b), $lte: Math.max(a, b) } };
    default: return null;
  }
}

/**
 * "Days ago" fields. `gt 30` = the date is MORE than 30 days in the past; `lt 30` = within the last 30 days.
 * Customers with no date (never purchased) never match a days-ago rule, which is what you want for
 * "hasn't bought in 30 days" (they are prospects, not lapsed buyers).
 */
function daysAgoClause(path, op, a, b, now) {
  if (Number.isNaN(a)) return null;
  const at = (n) => new Date(now.getTime() - n * DAY);
  switch (op) {
    case 'gt': return { [path]: { $lt: at(a) } };
    case 'gte': return { [path]: { $lte: at(a) } };
    case 'lt': return { [path]: { $gt: at(a) } };
    case 'lte': return { [path]: { $gte: at(a) } };
    case 'between': {
      if (Number.isNaN(b)) return null;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return { [path]: { $gte: at(hi), $lte: at(lo) } };
    }
    default: return null;
  }
}

function buildClause(rule, now) {
  const f = FIELDS[rule && rule.field];
  if (!f) return null;
  const { op, value, value2 } = rule;

  switch (f.type) {
    case 'money':
      return numericClause(f.path, op, Math.round(Number(value) * 100), Math.round(Number(value2) * 100));
    case 'number':
      return numericClause(f.path, op, Number(value), Number(value2));
    case 'daysAgo':
      return daysAgoClause(f.path, op, Number(value), Number(value2), now);
    case 'enum': {
      if (op === 'in' && Array.isArray(value)) return { [f.path]: { $in: value.map(String) } };
      if (op === 'neq') return { [f.path]: { $ne: String(value) } };
      return { [f.path]: String(value) };
    }
    case 'text': {
      const v = String(value ?? '').trim();
      if (!v) return null;
      if (op === 'contains') return { [f.path]: { $regex: escapeRegex(v), $options: 'i' } };
      if (op === 'neq') return { [f.path]: { $ne: v } };
      return { [f.path]: v };
    }
    case 'bool': {
      const yes = value === true || value === 'true' || value === 'yes';
      return yes ? { [f.path]: { $type: 'string' } } : { [f.path]: { $not: { $type: 'string' } } };
    }
    default:
      return null;
  }
}

/** rules + match('all'|'any') -> Mongo filter fragment (without businessId). Empty rules => {} (everyone). */
function buildRuleFilter(rules = [], match = 'all', now = new Date()) {
  const clauses = (rules || []).map((r) => buildClause(r, now)).filter(Boolean);
  if (!clauses.length) return {};
  return match === 'any' ? { $or: clauses } : { $and: clauses };
}

/* ------------------------------ built-in segments ------------------------------ */

function systemSegments(settings = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const atRiskAfter = Math.max(7, Math.round(s.inactiveDays * 0.6));
  return [
    { id: 'sys:new', name: 'New customers', color: '#2563eb', description: 'Bought once so far', match: 'all', rules: [{ field: 'lifecycle', op: 'eq', value: 'new' }] },
    { id: 'sys:returning', name: 'Returning customers', color: '#0f766e', description: 'Bought two or more times', match: 'all', rules: [{ field: 'lifecycle', op: 'eq', value: 'returning' }] },
    { id: 'sys:frequent', name: 'Frequent customers', color: '#7c3aed', description: `${s.frequentMinPurchases}+ purchases in ${s.frequentWindowDays} days`, match: 'all', rules: [{ field: 'lifecycle', op: 'eq', value: 'frequent' }] },
    { id: 'sys:vip', name: 'VIP customers', color: '#b45309', description: 'Your highest-value buyers', match: 'all', rules: [{ field: 'lifecycle', op: 'eq', value: 'vip' }] },
    {
      id: 'sys:at-risk', name: 'Slipping away', color: '#dc2626',
      description: `Repeat buyers quiet for ${atRiskAfter}+ days`, match: 'all',
      rules: [
        { field: 'purchaseCount', op: 'gte', value: 2 },
        { field: 'lastPurchaseDays', op: 'gte', value: atRiskAfter },
        { field: 'lifecycle', op: 'neq', value: 'inactive' },
      ],
    },
    { id: 'sys:inactive', name: 'Inactive customers', color: '#64748b', description: `No purchase in ${s.inactiveDays}+ days`, match: 'all', rules: [{ field: 'lifecycle', op: 'eq', value: 'inactive' }] },
    { id: 'sys:reachable', name: 'Reachable by SMS', color: '#0891b2', description: 'Has a valid phone number', match: 'all', rules: [{ field: 'hasPhone', op: 'eq', value: true }] },
  ];
}

module.exports = {
  LIFECYCLES, FIELDS, FIELD_KEYS, OPS, DEFAULT_SETTINGS, DAY,
  classify, buildRuleFilter, systemSegments, escapeRegex,
};