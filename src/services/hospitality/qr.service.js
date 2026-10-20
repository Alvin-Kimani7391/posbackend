/**
 * QR codes for tables and rooms. A code is a signed token: <t|r>_<id>_<version>_<signature>. It carries no business data and
 * cannot be forged or guessed; rotating the version invalidates every printed copy. The guest web page lives at
 * <baseUrl>/q/<token> and calls the public API with that token.
 */
const crypto = require('crypto');
const RestaurantTable = require('../../models/RestaurantTable');
const Room = require('../../models/Room');
const Stay = require('../../models/Stay');
const Branch = require('../../models/Branch');
const ApiError = require('../../utils/ApiError');
const C = require('./common');

const secret = () => process.env.QR_SECRET || require('../../config/env').jwt.secret;
const sig = (kind, id, ver) => crypto.createHmac('sha256', secret()).update(`${kind}:${id}:${ver}`).digest('base64url').slice(0, 22);
const KIND_CHAR = { TABLE: 't', ROOM: 'r', STORE: 'b' };
const CHAR_KIND = { t: 'TABLE', r: 'ROOM', b: 'STORE' };

const makeToken = (kind, doc) => `${KIND_CHAR[kind]}_${doc._id}_${doc.qrVersion || 1}_${sig(kind, doc._id, doc.qrVersion || 1)}`;

function parseToken(token) {
  const m = /^([trb])_([a-f0-9]{24})_(\d{1,6})_([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  const bad = () => ApiError.notFound('This QR code is not valid any more. Please ask a member of staff.', 'QR_INVALID');
  if (!m) throw bad();
  const kind = CHAR_KIND[m[1]]; const want = sig(kind, m[2], m[3]);
  if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(m[4]))) throw bad();
  return { kind, id: m[2], ver: Number(m[3]) };
}

/** Token -> the table or room, the business context and what a guest may do here. */
/** The business-wide storefront code. `doc` is a stand-in carrying the business id. */
async function resolveStore(businessId, ver) {
  const gone = () => ApiError.notFound('This QR code is not valid any more. Please ask a member of staff.', 'QR_INVALID');
  let ctx; try { ctx = await C.getAccContext(businessId); } catch (e) { throw gone(); }
  const st = ctx.settings.storefront || {};
  if ((st.qrVersion || 1) !== ver) throw gone();
  if (ctx.business.status && ctx.business.status !== 'active') throw ApiError.forbidden('This business is not taking orders right now.', 'BUSINESS_INACTIVE');
  if (!ctx.features.ordering || !st.enabled) throw ApiError.forbidden('Online ordering is switched off right now. Please call us.', 'STORE_DISABLED');
  return { kind: 'STORE', doc: { _id: ctx.business._id, businessId: ctx.business._id, active: true }, ctx, store: st, mode: 'STORE', stay: null };
}
const storeToken = (businessId, qrVersion = 1) => `b_${businessId}_${qrVersion}_${sig('STORE', businessId, qrVersion)}`;

async function resolve(token, { store = false } = {}) {
  const { kind, id, ver } = parseToken(token);
  if (kind === 'STORE') { if (!store) throw ApiError.notFound('This QR code is not valid any more. Please ask a member of staff.', 'QR_INVALID'); return resolveStore(id, ver); }
  const doc = kind === 'TABLE' ? await RestaurantTable.findById(id) : await Room.findById(id);
  const gone = () => ApiError.notFound('This QR code is not valid any more. Please ask a member of staff.', 'QR_INVALID');
  if (!doc || !doc.active || (doc.qrVersion || 1) !== ver || doc.qrEnabled === false) throw gone();
  const ctx = await C.getAccContext(doc.businessId);
  if (!ctx.features.ordering || !ctx.features.guestQr) throw ApiError.forbidden('Ordering by QR code is not available here', 'GUEST_QR_DISABLED');
  const go = ctx.settings.guestOrdering || {};
  let stay = null;
  if (kind === 'ROOM') {
    if (!ctx.features.accommodation) throw ApiError.forbidden('Rooms are not enabled here', 'FEATURE_DISABLED');
    if (doc.currentStayId) stay = await Stay.findById(doc.currentStayId);
    if (stay && (stay.status !== 'CHECKED_IN' || stay.qrOrdersEnabled === false)) stay = null;
  }
  const mode = kind === 'TABLE' ? go.tableMode : go.roomMode;
  return { kind, doc, ctx, mode: mode || 'OFF', stay };
}

function baseUrl(ctx) {
  // owner setting -> GUEST_APP_URL -> FRONTEND_URL (the web app itself; ignore the '*' wildcard) -> '' (the staff app then adds its own address)
  const fe = process.env.FRONTEND_URL && process.env.FRONTEND_URL !== '*' ? process.env.FRONTEND_URL.split(',')[0].trim() : '';
  return (ctx.settings.guestOrdering?.baseUrl || process.env.GUEST_APP_URL || fe || '').replace(/\/+$/, '');
}
const urlFor = (ctx, token) => (baseUrl(ctx) ? `${baseUrl(ctx)}/q/${token}` : `/q/${token}`);

async function listQr(businessId, user, { kind, branchId }) {
  C.requireCan(user, 'restaurant.guest.qr', 'Managing QR codes needs permission');
  const ctx = await C.getAccContext(businessId);
  if (kind === 'ROOM') C.assertAccommodation(ctx);
  const f = { businessId, active: true, ...C.branchFilter(C.branchScope(user, branchId)) };
  const docs = kind === 'TABLE' ? await RestaurantTable.find(f).sort({ name: 1 }) : await Room.find(f).sort({ number: 1 });
  const branches = new Map((await Branch.find({ businessId }).select('name')).map((b) => [String(b._id), b.name]));
  return docs.map((d) => { const t = makeToken(kind, d); return { id: d._id, kind, label: kind === 'TABLE' ? `Table ${d.name}` : `Room ${d.number}`, branch: branches.get(String(d.branchId)), branchId: d.branchId, enabled: d.qrEnabled !== false, version: d.qrVersion || 1, token: t, url: urlFor(ctx, t) }; });
}

async function rotate(businessId, user, { kind, id }) {
  C.requireCan(user, 'restaurant.guest.qr', 'Managing QR codes needs permission');
  const Model = kind === 'TABLE' ? RestaurantTable : Room;
  const d = await Model.findOne({ _id: id, businessId }); if (!d) throw ApiError.notFound('Not found', 'NOT_FOUND'); C.assertBranchAccess(user, d.branchId);
  d.qrVersion = (d.qrVersion || 1) + 1; await d.save();
  await C.audit({ businessId, branchId: d.branchId, userId: user._id, action: 'restaurant.qr.rotate', entityType: kind === 'TABLE' ? 'RestaurantTable' : 'Room', entityId: d._id, newValue: { version: d.qrVersion } });
  const ctx = await C.getAccContext(businessId); const t = makeToken(kind, d);
  return { id: d._id, kind, version: d.qrVersion, token: t, url: urlFor(ctx, t) };
}

async function setEnabled(businessId, user, { kind, id, enabled }) {
  C.requireCan(user, 'restaurant.guest.qr', 'Managing QR codes needs permission');
  const Model = kind === 'TABLE' ? RestaurantTable : Room;
  const d = await Model.findOne({ _id: id, businessId }); if (!d) throw ApiError.notFound('Not found', 'NOT_FOUND'); C.assertBranchAccess(user, d.branchId);
  d.qrEnabled = !!enabled; await d.save(); return { id: d._id, kind, enabled: d.qrEnabled };
}

/** The one storefront QR for the business: link, token and version (staff with QR permission). */
async function storeQr(businessId, user) {
  C.requireCan(user, 'restaurant.guest.qr', 'Managing QR codes needs permission');
  const ctx = await C.getAccContext(businessId); const v = ctx.settings.storefront?.qrVersion || 1; const t = storeToken(businessId, v);
  const fe = process.env.FRONTEND_URL && process.env.FRONTEND_URL !== '*' ? process.env.FRONTEND_URL.split(',')[0].trim() : '';
  const base = (ctx.settings.guestOrdering?.baseUrl || process.env.GUEST_APP_URL || fe || '').replace(/\/+$/, '');
  return { token: t, version: v, enabled: !!ctx.settings.storefront?.enabled, url: base ? `${base}/store.html?t=${t}` : `/store.html?t=${t}`, businessName: ctx.business.name };
}
async function rotateStore(businessId, user) {
  C.requireCan(user, 'restaurant.guest.qr', 'Managing QR codes needs permission');
  const RestaurantSettings = require('../../models/RestaurantSettings');
  await C.getContext(businessId); await RestaurantSettings.updateOne({ businessId }, { $inc: { 'storefront.qrVersion': 1 } });
  return storeQr(businessId, user);
}
module.exports = { storeToken, storeQr, rotateStore, makeToken, parseToken, resolve, urlFor, listQr, rotate, setEnabled };