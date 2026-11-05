/**
 * permissionResolver.js
 * THE single place that answers "what can this user do?".
 *
 * Layers, applied in order (later layers win):
 *   1. system   - built-in defaults for the user's role (constants/permissions.js)
 *   2. role     - the owner's business-wide template for that role   (policy.roleOverrides)
 *   3. group    - each custom group the employee belongs to          (policy.groups)   [custom mode only]
 *   4. person   - the employee's own extra grants / revokes          (user.granted/revoked) [custom mode only]
 *
 * Mode:  'default' -> layers 1-2 only.   'custom' -> all four layers.
 * Legacy users (no permissionMode stored) are 'custom' when they already have grants/revokes, else 'default',
 * so nothing changes for existing accounts and no migration is needed.
 *
 * OWNER always has everything. SUPER_ADMIN has nothing on tenant routes.
 * Pure + synchronous so it is safe to call from anywhere. DB-free.
 */
const { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } = require('../constants/permissions');
const { ROLES } = require('../constants/roles');

const ALL = new Set(PERMISSIONS);

/* ---- per-business policy cache (primed by authenticate() on every request, and on every policy write) ---- */
const policyCache = new Map();
const MAX_CACHE = 5000;
function cachePolicy(businessId, policy) {
  if (!businessId) return;
  if (policyCache.size > MAX_CACHE) policyCache.clear();
  policyCache.set(String(businessId), policy || null);
}
const cachedPolicy = (businessId) => (businessId ? policyCache.get(String(businessId)) || null : null);

const arr = (x) => (Array.isArray(x) ? x : []);

function modeOf(user) {
  if (user.permissionMode === 'default' || user.permissionMode === 'custom') return user.permissionMode;
  return arr(user.grantedPermissions).length || arr(user.revokedPermissions).length || arr(user.permissionGroupIds).length ? 'custom' : 'default';
}

/** The ordered layers that apply to this user (used by both the fast path and the explainer). */
function layersFor(user, policy) {
  const layers = [];
  const role = user.role;
  layers.push({ type: 'system', label: `System default (${role})`, add: DEFAULT_ROLE_PERMISSIONS[role] || [], remove: [] });

  const ro = arr(policy && policy.roleOverrides).find((r) => r.role === role);
  if (ro && (arr(ro.grant).length || arr(ro.revoke).length)) {
    layers.push({ type: 'role', label: `Business template for ${role}`, add: arr(ro.grant), remove: arr(ro.revoke) });
  }

  if (modeOf(user) === 'custom') {
    const groups = arr(policy && policy.groups);
    for (const gid of arr(user.permissionGroupIds)) {
      const g = groups.find((x) => String(x._id) === String(gid));
      if (g) layers.push({ type: 'group', label: `Group: ${g.name}`, groupId: String(g._id), add: arr(g.grant), remove: arr(g.revoke) });
    }
    if (arr(user.grantedPermissions).length || arr(user.revokedPermissions).length) {
      layers.push({ type: 'person', label: 'Set for this employee', add: arr(user.grantedPermissions), remove: arr(user.revokedPermissions) });
    }
  }
  return layers;
}

/** -> Set of permission keys the user effectively holds. */
function computeEffective(user, policy) {
  if (!user) return new Set();
  if (user.role === ROLES.OWNER) return new Set(ALL);
  if (user.role === ROLES.SUPER_ADMIN) return new Set();
  const set = new Set();
  for (const layer of layersFor(user, policy)) {
    // remove first, then add: within one layer an explicit grant beats an explicit revoke (validators keep them disjoint anyway)
    for (const p of layer.remove) set.delete(p);
    for (const p of layer.add) set.add(p);
  }
  return set;
}

/**
 * Explain every permission: allowed?, and which layer made the final decision.
 * -> [{ permission, allowed, byDefault, source: {type,label}|null }]
 */
function explain(user, policy, keys = PERMISSIONS) {
  const owner = user.role === ROLES.OWNER;
  const layers = owner ? [] : layersFor(user, policy);
  return keys.map((permission) => {
    if (owner) return { permission, allowed: true, byDefault: true, source: { type: 'owner', label: 'Owner has full access' } };
    let allowed = false; let source = null; const byDefault = layers[0].add.includes(permission);
    for (const l of layers) {
      if (l.remove.includes(permission)) { allowed = false; source = { type: l.type, label: l.label, effect: 'deny' }; }
      if (l.add.includes(permission)) { allowed = true; source = { type: l.type, label: l.label, effect: 'allow' }; }
    }
    return { permission, allowed, byDefault, source };
  });
}

/* Memoise per user object (a request's lifetime) so hot routes don't recompute. */
const memo = new WeakMap();
function effectiveFor(user, { fresh = false } = {}) {
  if (!user || typeof user !== 'object') return new Set();
  if (!fresh) { const hit = memo.get(user); if (hit) return hit; }
  const policy = user.__policy !== undefined ? user.__policy : cachedPolicy(user.businessId);
  const set = computeEffective(user, policy);
  memo.set(user, set);
  return set;
}

function userHasPermission(user, permission) {
  if (!user) return false;
  if (user.role === ROLES.OWNER) return true;
  return effectiveFor(user).has(permission);
}

/** True when the user holds `permission` through an owner decision (template / group / personal), not just the built-in role default. */
function hasNonDefaultGrant(user, permission) {
  if (!userHasPermission(user, permission)) return false;
  return !(DEFAULT_ROLE_PERMISSIONS[user.role] || []).includes(permission);
}

module.exports = { computeEffective, explain, effectiveFor, userHasPermission, hasNonDefaultGrant, layersFor, modeOf, cachePolicy, cachedPolicy, ALL };
