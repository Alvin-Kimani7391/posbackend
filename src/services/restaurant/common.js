/**
 * Shared plumbing for the restaurant services: transactions, settings, access rules, audit, notifications.
 * Nothing here is business logic that belongs to a single module.
 */
const mongoose = require('mongoose');
const Business = require('../../models/Business');
const Branch = require('../../models/Branch');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const RestaurantSettings = require('../../models/RestaurantSettings');
const KitchenStation = require('../../models/KitchenStation');
const RestaurantOrder = require('../../models/RestaurantOrder');
const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissionCheck');
const { ROLES } = require('../../constants/roles');
const { orderTotals } = require('../../utils/restaurantBilling');
const notificationService = require('../notification.service');

async function inTx(fn) {
  const session = await mongoose.startSession();
  try { let out; await session.withTransaction(async () => { out = await fn(session); }); return out; } finally { session.endSession(); }
}

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const sid = (v) => (v ? String(v) : '');
const sameId = (a, b) => sid(a) === sid(b);
const withSession = (q, session) => (session ? q.session(session) : q);

/** Settings for the business (created with defaults on first use) + the business facts every restaurant calculation needs. */
async function getContext(businessId, session) {
  let settings = await withSession(RestaurantSettings.findOne({ businessId }), session);
  if (!settings) {
    try { [settings] = await RestaurantSettings.create([{ businessId }], session ? { session } : {}); } catch (e) { if (e.code !== 11000) throw e; settings = await withSession(RestaurantSettings.findOne({ businessId }), session); }
  }
  const business = await withSession(Business.findById(businessId), session);
  if (!business) throw ApiError.notFound('Business not found');
  const f = business.featureSettings || {};
  return {
    business, settings,
    features: { ordering: f.restaurantOrdering === true, tables: f.tableManagement === true, kitchen: f.kitchenDisplay === true, recipes: f.recipeManagement === true, reservations: f.reservations === true, batches: f.batchTracking === true, guestQr: f.guestQrOrdering === true, accommodation: f.accommodation === true },
    timeZone: business.timezone || 'Africa/Nairobi',
    taxInclusive: business.taxSettings?.taxInclusive !== false,
    defaultTaxRate: business.vatRegistered ? (business.taxSettings?.defaultTaxRate ?? 0) : 0,
  };
}

/** Service-charge parameters that apply to an order type under the current settings. */
function scConfig(settings, orderType) {
  const sc = settings.serviceCharge || {};
  if (!sc.enabled || !(sc.orderTypes || []).includes(orderType)) return { scPercent: 0, scTaxRate: 0 };
  return { scPercent: sc.percent || 0, scTaxRate: sc.taxRate || 0 };
}

const audit = (entry, session) => AuditLog.create([entry], session ? { session } : {});

const can = (user, perm) => hasPermission(user, perm);
const requireCan = (user, perm, message) => { if (!can(user, perm)) throw ApiError.forbidden(message || `Missing permission: ${perm}`, 'PERMISSION_DENIED'); };

/** OWNER/ADMIN reach every branch; everyone else only the branches they are assigned to. */
function assertBranchAccess(user, branchId) {
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) return;
  if (!(user.branchIds || []).some((b) => sameId(b, branchId))) throw ApiError.forbidden('You do not have access to this branch', 'BRANCH_ACCESS_DENIED');
}

async function assertBranch(businessId, branchId, session) {
  const b = await withSession(Branch.findOne({ _id: branchId, businessId }).select('_id name code phone'), session);
  if (!b) throw ApiError.badRequest('Branch not found', 'BRANCH_NOT_FOUND');
  return b;
}

/** Branch ids a caller may query: an explicit branchId (checked), else everything they may see (null = all, for owner/admin). */
function branchScope(user, branchId) {
  if (branchId) { assertBranchAccess(user, branchId); return [oid(branchId)]; }
  if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) return null;
  return (user.branchIds || []).map(oid);
}
const branchFilter = (scope) => (scope === null ? {} : { branchId: { $in: scope } });

async function loadOrder(businessId, id, session) {
  const order = await withSession(RestaurantOrder.findOne({ _id: id, businessId }), session);
  if (!order) throw ApiError.notFound('Order not found', 'ORDER_NOT_FOUND');
  return order;
}

/** A waiter without view_all may only touch orders they opened or are assigned to. */
function assertOrderAccess(user, order, { write = false } = {}) {
  assertBranchAccess(user, order.branchId);
  if (can(user, 'restaurant.orders.view_all')) return;
  if (sameId(order.waiterId, user._id) || sameId(order.openedBy, user._id)) return;
  if (!order.waiterId && can(user, 'restaurant.orders.create')) return;      // a guest's QR order nobody has claimed yet
  throw ApiError.forbidden(write ? 'This order belongs to another waiter' : 'You can only see your own orders', 'ORDER_NOT_YOURS');
}

function assertOpen(order) {
  if (order.status !== 'OPEN') throw ApiError.conflict(`Order is ${order.status}`, 'ORDER_NOT_OPEN');
}

/** Optimistic concurrency: a client that sends expectedVersion gets a clear conflict instead of silently overwriting. */
function checkVersion(order, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== null && order.version !== expectedVersion) {
    throw ApiError.conflict(`This order was changed by someone else (version ${order.version}, you had ${expectedVersion}). Refresh and try again.`, 'ORDER_VERSION_CONFLICT');
  }
}

function recalcOrder(order, ctx) {
  const t = orderTotals(order.items, { taxInclusive: ctx.taxInclusive, ...scConfig(ctx.settings, order.orderType) });
  order.totals = { itemsTotal: t.itemsTotal, serviceCharge: t.serviceCharge, tax: t.tax, total: t.total, discount: t.discount };
}

/** Records the change on the order's own history and bumps its version. Call before every save. */
function touch(order, userId, action, note, data) {
  order.history.push({ at: new Date(), action, by: userId, note, data });
  order.version = (order.version || 1) + 1;
}

/** Stations are per branch; zero-config restaurants get a KITCHEN and a BAR station automatically. */
async function ensureStations(businessId, branchId, session) {
  const existing = await withSession(KitchenStation.find({ businessId, branchId, status: 'active' }), session);
  if (existing.length) return existing;
  try {
    return await KitchenStation.create([
      { businessId, branchId, name: 'Kitchen', code: 'KITCHEN', type: 'KITCHEN', isDefault: true },
      { businessId, branchId, name: 'Bar', code: 'BAR', type: 'BAR' },
    ], session ? { session } : {});
  } catch (e) { if (e.code === 11000) return withSession(KitchenStation.find({ businessId, branchId, status: 'active' }), session); throw e; }
}
async function stationFor(businessId, branchId, code, session, cache) {
  const list = cache || await ensureStations(businessId, branchId, session);
  return list.find((s) => s.code === String(code || '').toUpperCase()) || list.find((s) => s.isDefault) || list[0];
}

/** Fire-and-forget notifications: a failed alert must never fail the till. */
const quiet = (p) => Promise.resolve(p).catch((e) => console.error('[restaurant] notification failed:', e.message));
const notifyUser = (businessId, userId, payload) => (userId ? quiet(notificationService.notifyUser(businessId, userId, payload)) : null);
const notifyManagement = (businessId, payload) => quiet(notificationService.notifyManagement(businessId, payload));
async function notifyRoles(businessId, branchId, roles, payload) {
  try {
    const users = await User.find({ businessId, status: 'active', role: { $in: roles }, $or: [{ branchIds: branchId }, { branchIds: { $size: 0 } }] }).select('_id');
    await Promise.all(users.map((u) => quiet(notificationService.notifyUser(businessId, u._id, { ...payload, branchId }))));
  } catch (e) { console.error('[restaurant] notifyRoles failed:', e.message); }
}
const FLOOR_LEAD_ROLES = [ROLES.SUPERVISOR, ROLES.HEAD_WAITER, ROLES.MANAGER];
const CASHIER_ROLES = [ROLES.CASHIER, ROLES.SUPERVISOR, ROLES.MANAGER];
const KITCHEN_ROLES = [ROLES.CHEF, ROLES.KITCHEN_STAFF, ROLES.EXPEDITOR, ROLES.BARTENDER];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const page = ({ page: p = 1, limit = 20 } = {}) => ({ page: p, limit, skip: (p - 1) * limit });
const paged = (items, total, { page: p = 1, limit = 20 }) => ({ items, total, page: p, limit, pages: Math.ceil(total / limit) || 1 });

module.exports = {
  inTx, oid, sid, sameId, withSession, getContext, scConfig, audit, can, requireCan, assertBranchAccess, assertBranch, branchScope, branchFilter,
  loadOrder, assertOrderAccess, assertOpen, checkVersion, recalcOrder, touch, ensureStations, stationFor,
  notifyUser, notifyManagement, notifyRoles, FLOOR_LEAD_ROLES, CASHIER_ROLES, KITCHEN_ROLES, escapeRegex, page, paged,
};
