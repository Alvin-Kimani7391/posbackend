/**
 * permission.service.js
 * Owner-controlled access: role templates, custom groups, per-employee overrides, bulk changes, and "why can they?" explanations.
 *
 * Safety rules (enforced here, not just in the UI):
 *  - Only people holding `employees.permissions` get in at all (route-level); by default that is the OWNER only.
 *  - Nobody can hand out a permission they do not hold themselves (no privilege escalation).
 *  - Nobody can change their own permissions, and the OWNER's access can never be reduced.
 *  - Only the OWNER can change an ADMIN's access or the ADMIN role template.
 *  - Unknown permission keys are rejected; a permission cannot be both allowed and denied.
 *  - Every change is audit-logged with exactly which effective permissions were added / removed.
 */
const mongoose = require('mongoose');
const Business = require('../models/Business');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const { PERMISSIONS } = require('../constants/permissions');
const { getCatalog } = require('../constants/permissionCatalog');
const R = require('../utils/permissionResolver');

const VALID = new Set(PERMISSIONS);
const TENANT_ROLES = Object.values(ROLES).filter((r) => r !== ROLES.SUPER_ADMIN && r !== ROLES.OWNER);
const MAX_GROUPS = 30;
const uniq = (a) => [...new Set((a || []).map(String))];
const emptyPolicy = () => ({ roleOverrides: [], groups: [], version: 0 });

/* ------------------------------ validation helpers ------------------------------ */

function assertKnown(keys) {
  const bad = keys.filter((k) => !VALID.has(k));
  if (bad.length) throw ApiError.badRequest(`Unknown permission: ${bad.slice(0, 5).join(', ')}`, 'UNKNOWN_PERMISSION');
}
function disjoint(grant, revoke) {
  const r = new Set(revoke);
  const both = grant.filter((g) => r.has(g));
  if (both.length) throw ApiError.badRequest(`A permission cannot be both allowed and denied: ${both.slice(0, 5).join(', ')}`, 'PERMISSION_CONFLICT');
}
function assertCanGrant(actor, keys) {
  const lacking = keys.filter((k) => !R.userHasPermission(actor, k));
  if (lacking.length) throw ApiError.forbidden(`You cannot give permissions you do not have yourself: ${lacking.slice(0, 5).join(', ')}`, 'CANNOT_GRANT_UNHELD');
}
const newlyAdded = (next, prev) => { const p = new Set(prev || []); return next.filter((x) => !p.has(x)); };

/* ------------------------------ policy storage ------------------------------ */

async function getPolicy(businessId) {
  const b = await Business.findById(businessId).select('permissionPolicy').lean();
  if (!b) throw ApiError.notFound('Business not found');
  const p = b.permissionPolicy || emptyPolicy();
  return { roleOverrides: p.roleOverrides || [], groups: p.groups || [], version: p.version || 0 };
}

/** Optimistic read-modify-write so two owners editing at once never silently overwrite each other. */
async function mutatePolicy(businessId, fn) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await getPolicy(businessId);
    const next = fn(JSON.parse(JSON.stringify(current)), current);
    next.version = current.version + 1;
    const versionFilter = current.version === 0
      ? { $or: [{ 'permissionPolicy.version': 0 }, { 'permissionPolicy.version': { $exists: false } }] }
      : { 'permissionPolicy.version': current.version };
    const res = await Business.updateOne({ _id: businessId, ...versionFilter }, { $set: { permissionPolicy: next } });
    if (res.matchedCount || res.n) { R.cachePolicy(businessId, next); return next; }
  }
  throw ApiError.conflict('Access settings were changed by someone else. Reload and try again.', 'POLICY_CONFLICT');
}

const audit = (businessId, actor, action, entityId, oldValue, newValue, meta = {}) =>
  AuditLog.create({ businessId, userId: actor._id, action, entityType: action.startsWith('employee') ? 'User' : 'Business', entityId, oldValue, newValue, ipAddress: meta.ip, userAgent: meta.userAgent })
    .catch((e) => console.error('[permissions audit]', e.message));

/* ------------------------------ reads ------------------------------ */

const getCatalogView = () => getCatalog();

async function getPolicyView(businessId) {
  const p = await getPolicy(businessId);
  const counts = await User.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), status: { $ne: 'inactive' } } },
    { $group: { _id: '$role', n: { $sum: 1 } } },
  ]);
  const byRole = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  const members = await User.aggregate([
    { $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), status: { $ne: 'inactive' } } },
    { $unwind: '$permissionGroupIds' },
    { $group: { _id: '$permissionGroupIds', n: { $sum: 1 } } },
  ]);
  const byGroup = Object.fromEntries(members.map((m) => [String(m._id), m.n]));
  return {
    version: p.version,
    roleOverrides: p.roleOverrides,
    groups: p.groups.map((g) => ({ ...g, memberCount: byGroup[String(g._id)] || 0 })),
    roleCounts: byRole,
  };
}

const summarize = (u, policy) => ({
  _id: u._id, name: u.name, role: u.role, status: u.status, employeeCode: u.employeeCode || null,
  mode: R.modeOf(u), groupIds: (u.permissionGroupIds || []).map(String),
  grantCount: (u.grantedPermissions || []).length, revokeCount: (u.revokedPermissions || []).length,
  effectiveCount: R.computeEffective(u, policy).size,
});

async function listEmployees(businessId) {
  const [policy, users] = await Promise.all([
    getPolicy(businessId),
    User.find({ businessId, status: { $ne: 'inactive' } }).select('name role status employeeCode grantedPermissions revokedPermissions permissionMode permissionGroupIds').sort({ name: 1 }).limit(500),
  ]);
  return { items: users.map((u) => summarize(u, policy)), total: users.length };
}

async function getEmployeeAccess(businessId, id) {
  const [policy, user] = await Promise.all([getPolicy(businessId), User.findOne({ _id: id, businessId })]);
  if (!user) throw ApiError.notFound('Employee not found');
  const trace = R.explain(user, policy);
  return {
    employee: { ...summarize(user, policy), grant: user.grantedPermissions || [], revoke: user.revokedPermissions || [], phone: user.phone },
    effective: trace.filter((t) => t.allowed).map((t) => t.permission),
    trace, // [{ permission, allowed, byDefault, source }]
  };
}

/* ------------------------------ role templates ------------------------------ */

function assertRoleEditable(actor, role) {
  if (!TENANT_ROLES.includes(role)) throw ApiError.badRequest('That role cannot be customised', 'INVALID_ROLE');
  if (actor.role !== ROLES.OWNER && (role === ROLES.ADMIN || role === actor.role)) {
    throw ApiError.forbidden('Only the owner can change the access of the Admin role or your own role', 'OWNER_ONLY');
  }
}

async function setRoleTemplate(businessId, actor, role, { grant = [], revoke = [] }, meta) {
  assertRoleEditable(actor, role);
  grant = uniq(grant); revoke = uniq(revoke);
  assertKnown([...grant, ...revoke]); disjoint(grant, revoke);
  const before = (await getPolicy(businessId)).roleOverrides.find((r) => r.role === role) || { grant: [], revoke: [] };
  assertCanGrant(actor, newlyAdded(grant, before.grant));
  const next = await mutatePolicy(businessId, (p) => {
    p.roleOverrides = p.roleOverrides.filter((r) => r.role !== role);
    if (grant.length || revoke.length) p.roleOverrides.push({ role, grant, revoke, updatedAt: new Date(), updatedBy: actor._id });
    return p;
  });
  await audit(businessId, actor, 'permissions.role_template', businessId, { role, grant: before.grant, revoke: before.revoke }, { role, grant, revoke }, meta);
  return next;
}
const resetRoleTemplate = (businessId, actor, role, meta) => setRoleTemplate(businessId, actor, role, { grant: [], revoke: [] }, meta);

/* ------------------------------ groups ------------------------------ */

async function createGroup(businessId, actor, data, meta) {
  const grant = uniq(data.grant); const revoke = uniq(data.revoke);
  assertKnown([...grant, ...revoke]); disjoint(grant, revoke); assertCanGrant(actor, grant);
  let created;
  await mutatePolicy(businessId, (p) => {
    if (p.groups.length >= MAX_GROUPS) throw ApiError.badRequest(`You can have up to ${MAX_GROUPS} groups`, 'TOO_MANY_GROUPS');
    if (p.groups.some((g) => g.name.toLowerCase() === data.name.trim().toLowerCase())) throw ApiError.conflict('A group with that name already exists', 'GROUP_EXISTS');
    created = { _id: new mongoose.Types.ObjectId(), name: data.name.trim(), description: data.description || '', color: data.color || '', grant, revoke, createdBy: actor._id, createdAt: new Date(), updatedAt: new Date() };
    p.groups.push(created);
    return p;
  });
  await audit(businessId, actor, 'permissions.group_create', businessId, null, { name: created.name, grant, revoke }, meta);
  return created;
}

async function updateGroup(businessId, actor, groupId, data, meta) {
  let before; let after;
  await mutatePolicy(businessId, (p) => {
    const g = p.groups.find((x) => String(x._id) === String(groupId));
    if (!g) throw ApiError.notFound('Group not found');
    before = JSON.parse(JSON.stringify(g));
    const grant = data.grant ? uniq(data.grant) : g.grant; const revoke = data.revoke ? uniq(data.revoke) : g.revoke;
    assertKnown([...grant, ...revoke]); disjoint(grant, revoke); assertCanGrant(actor, newlyAdded(grant, g.grant));
    if (data.name && p.groups.some((x) => String(x._id) !== String(groupId) && x.name.toLowerCase() === data.name.trim().toLowerCase())) throw ApiError.conflict('A group with that name already exists', 'GROUP_EXISTS');
    if (data.name) g.name = data.name.trim();
    if (data.description !== undefined) g.description = data.description;
    if (data.color !== undefined) g.color = data.color;
    g.grant = grant; g.revoke = revoke; g.updatedAt = new Date();
    after = g;
    return p;
  });
  await audit(businessId, actor, 'permissions.group_update', businessId, { name: before.name, grant: before.grant, revoke: before.revoke }, { name: after.name, grant: after.grant, revoke: after.revoke }, meta);
  return after;
}

async function deleteGroup(businessId, actor, groupId, meta) {
  let removed;
  await mutatePolicy(businessId, (p) => {
    removed = p.groups.find((x) => String(x._id) === String(groupId));
    if (!removed) throw ApiError.notFound('Group not found');
    p.groups = p.groups.filter((x) => String(x._id) !== String(groupId));
    return p;
  });
  const res = await User.updateMany({ businessId, permissionGroupIds: groupId }, { $pull: { permissionGroupIds: new mongoose.Types.ObjectId(String(groupId)) } });
  await audit(businessId, actor, 'permissions.group_delete', businessId, { name: removed.name, grant: removed.grant, revoke: removed.revoke }, { membersRemoved: res.modifiedCount || res.nModified || 0 }, meta);
  return { deleted: true };
}

/* ------------------------------ employees ------------------------------ */

async function loadTarget(businessId, actor, id) {
  const user = await User.findOne({ _id: id, businessId });
  if (!user) throw ApiError.notFound('Employee not found');
  if (user.role === ROLES.OWNER) throw ApiError.badRequest("The owner always has full access and can't be changed", 'OWNER_FIXED');
  if (String(user._id) === String(actor._id)) throw ApiError.forbidden("You can't change your own permissions", 'SELF_CHANGE');
  if (user.role === ROLES.ADMIN && actor.role !== ROLES.OWNER) throw ApiError.forbidden("Only the owner can change an admin's permissions", 'OWNER_ONLY');
  return user;
}

/** Applies `change` to the user document (does not save). Returns nothing; throws on any rule violation. */
function applyChange(user, policy, actor, ch) {
  if (ch.reset) {
    user.grantedPermissions = []; user.revokedPermissions = []; user.permissionGroupIds = []; user.permissionMode = 'default';
    return;
  }
  const touchesCustom = ch.groupIds !== undefined || ch.grant !== undefined || ch.revoke !== undefined;
  const wasDefault = R.modeOf(user) === 'default'; // read BEFORE editing: the resolver infers mode from stored data

  if (ch.groupIds !== undefined) {
    const ids = uniq(ch.groupIds);
    const known = new Map(policy.groups.map((g) => [String(g._id), g]));
    const missing = ids.filter((i) => !known.has(i));
    if (missing.length) throw ApiError.badRequest('One of the selected groups no longer exists', 'GROUP_NOT_FOUND');
    const fresh = newlyAdded(ids, (user.permissionGroupIds || []).map(String));
    assertCanGrant(actor, fresh.flatMap((i) => known.get(i).grant || []));
    user.permissionGroupIds = ids;
  }

  if (ch.grant !== undefined || ch.revoke !== undefined) {
    const grant = uniq(ch.grant !== undefined ? ch.grant : user.grantedPermissions);
    const revoke = uniq(ch.revoke !== undefined ? ch.revoke : user.revokedPermissions);
    assertKnown([...grant, ...revoke]); disjoint(grant, revoke);
    assertCanGrant(actor, newlyAdded(grant, user.grantedPermissions));
    user.grantedPermissions = grant; user.revokedPermissions = revoke;
  }

  if (ch.mode) user.permissionMode = ch.mode;
  else if (touchesCustom && wasDefault) user.permissionMode = 'custom'; // editing implies you want it to apply
}

const snap = (u) => ({ mode: R.modeOf(u), groups: (u.permissionGroupIds || []).map(String), grant: [...(u.grantedPermissions || [])], revoke: [...(u.revokedPermissions || [])] });

async function updateEmployee(businessId, actor, id, ch, meta, preloaded) {
  const policy = preloaded || await getPolicy(businessId);
  const user = await loadTarget(businessId, actor, id);
  const beforeSet = R.computeEffective(user, policy); const beforeSnap = snap(user);
  applyChange(user, policy, actor, ch);
  await user.save();
  const afterSet = R.computeEffective(user, policy);
  const diff = { added: [...afterSet].filter((p) => !beforeSet.has(p)).sort(), removed: [...beforeSet].filter((p) => !afterSet.has(p)).sort() };
  await audit(businessId, actor, 'employee.permissions.update', user._id, { ...beforeSnap }, { ...snap(user), effectiveAdded: diff.added, effectiveRemoved: diff.removed }, meta);
  return { employee: summarize(user, policy), diff };
}

/**
 * Bulk: one operation across many employees ("everyone in this group", "all cashiers", ticked rows).
 * op: setMode | addGroup | removeGroup | grant | revoke | inherit | reset
 * Employees that break a rule are skipped with a reason; the rest still succeed.
 */
async function bulkUpdate(businessId, actor, { employeeIds, op, mode, groupId, permissions = [] }, meta) {
  const policy = await getPolicy(businessId);
  const perms = uniq(permissions);
  if (['grant', 'revoke', 'inherit'].includes(op)) { if (!perms.length) throw ApiError.badRequest('Choose at least one permission', 'NO_PERMISSIONS'); assertKnown(perms); }
  if (['addGroup', 'removeGroup'].includes(op) && !groupId) throw ApiError.badRequest('Choose a group', 'NO_GROUP');
  if (op === 'setMode' && !mode) throw ApiError.badRequest('Choose a mode', 'NO_MODE');

  const updated = []; const skipped = [];
  for (const id of uniq(employeeIds)) {
    try {
      const user = await User.findOne({ _id: id, businessId }).select('grantedPermissions revokedPermissions permissionGroupIds permissionMode role');
      if (!user) throw ApiError.notFound('Employee not found');
      const g = new Set(user.grantedPermissions || []); const r = new Set(user.revokedPermissions || []);
      let ch;
      if (op === 'reset') ch = { reset: true };
      else if (op === 'setMode') ch = { mode };
      else if (op === 'addGroup') ch = { groupIds: [...(user.permissionGroupIds || []).map(String), String(groupId)] };
      else if (op === 'removeGroup') ch = { groupIds: (user.permissionGroupIds || []).map(String).filter((x) => x !== String(groupId)) };
      else if (op === 'grant') { perms.forEach((p) => { g.add(p); r.delete(p); }); ch = { grant: [...g], revoke: [...r] }; }
      else if (op === 'revoke') { perms.forEach((p) => { r.add(p); g.delete(p); }); ch = { grant: [...g], revoke: [...r] }; }
      else if (op === 'inherit') { perms.forEach((p) => { r.delete(p); g.delete(p); }); ch = { grant: [...g], revoke: [...r] }; }
      else throw ApiError.badRequest('Unknown operation', 'BAD_OP');
      const out = await updateEmployee(businessId, actor, id, ch, { ...meta, bulk: true }, policy);
      updated.push({ id, ...out.diff });
    } catch (e) {
      skipped.push({ id, reason: e.message || 'Failed' });
    }
  }
  return { updated: updated.length, skipped, results: updated };
}

/** Used by employee creation: set a new hire's access in the same request. */
async function applyToNewEmployee(businessId, actor, user, ch, meta) {
  const policy = await getPolicy(businessId);
  applyChange(user, policy, actor, ch);
  await user.save();
  await audit(businessId, actor, 'employee.permissions.update', user._id, null, snap(user), meta);
}

const myPermissions = (user) => ({ role: user.role, mode: R.modeOf(user), permissions: [...R.effectiveFor(user, { fresh: true })].sort() });

module.exports = {
  getCatalogView, getPolicyView, listEmployees, getEmployeeAccess, setRoleTemplate, resetRoleTemplate,
  createGroup, updateGroup, deleteGroup, updateEmployee, bulkUpdate, applyToNewEmployee, myPermissions,
  _test: { applyChange, assertRoleEditable },
};
