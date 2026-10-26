/**
 * Live TV (digital menu board). The POS stays the source of truth: slides store WHAT to show, prices are read from the live menu
 * (branch price, order-type price, happy hour / promotion) every time a TV renders. Drafts are private until published; a TV only
 * ever receives the published snapshot of its playlist. TVs authenticate with a revocable device token, never a staff login.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const T = require('../../constants/tv');
const { ROLES } = require('../../constants/roles');
const { assertBranchAccess, canAccessBranch } = require('../../utils/branchAccess');
const { inAnyWindow } = require('../../utils/restaurantTime');
const { fromCents } = require('../../utils/money');
const hub = require('../delivery/realtime.hub');
const AuditLog = require('../../models/AuditLog');
const Business = require('../../models/Business');
const Branch = require('../../models/Branch');
const MenuItem = require('../../models/MenuItem');
const Category = require('../../models/Category');
const RoomType = require('../../models/RoomType');
const { TvPlaylist, TvPublication, TvPromotion, TvMedia, TvSettings, TvScreen } = require('../../models/TvModels');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const oid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(String(v)) : null);
const idStr = (v) => String(v);
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => { let s = ''; for (let i = 0; i < 8; i += 1) s += ALPHA[crypto.randomInt(ALPHA.length)]; return s; };
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const prettyCode = (c) => `${c.slice(0, 4)}-${c.slice(4)}`;
const SYSTEM = { _id: null, role: ROLES.OWNER, branchIds: [], grantedPermissions: [], revokedPermissions: [] };
const log = (bid, user, action, entityType, entityId, newValue, branchId) =>
  AuditLog.create({ businessId: bid, branchId, userId: user && user._id, action: `tv.${action}`, entityType, entityId, newValue }).catch(() => {});
const nf = (what) => ApiError.notFound(`${what} not found`);

// ------------------------------------------------------------------ realtime
const chan = (bid) => `tvb:${bid}`;
const push = (bid, event, data) => { try { hub.publish(chan(bid), event, data); } catch (e) { /* never break a write because a stream failed */ } };
const timers = new Map();
/** Called when the menu / prices change anywhere (menu.service#bustMenu). Debounced so a burst of edits is one refresh. */
function menuChanged(bid) {
  const k = String(bid); if (timers.has(k)) return;
  const t = setTimeout(() => { timers.delete(k); push(k, 'refresh', { reason: 'menu' }); }, 2000); if (t.unref) t.unref(); timers.set(k, t);
}

// ------------------------------------------------------------------ settings
async function getSettings(bid) {
  let s = await TvSettings.findOne({ businessId: bid });
  if (!s) { try { s = await TvSettings.create({ businessId: bid }); } catch (e) { if (e.code !== 11000) throw e; s = await TvSettings.findOne({ businessId: bid }); } }
  return s;
}
async function updateSettings(bid, user, input) {
  const s = await getSettings(bid); s.set(input); await s.save();
  await log(bid, user, 'settings.update', 'TvSettings', s._id, input); push(bid, 'refresh', { reason: 'settings' }); return s;
}

// ------------------------------------------------------------------ editor helpers (what a manager can pick from)
async function options(bid, user) {
  const [items, cats, rooms, branches] = await Promise.all([
    MenuItem.find({ businessId: bid, status: 'active' }).select('name image categoryId basePrice isCombo soldOut').sort({ sortOrder: 1, name: 1 }).lean(),
    Category.find({ businessId: bid, status: 'active' }).select('name').sort({ name: 1 }).lean(),
    RoomType.find({ businessId: bid, active: true }).select('name images baseRate').lean(),
    Branch.find({ businessId: bid, status: 'active' }).select('name code').lean(),
  ]);
  return { menuItems: items.map((i) => ({ ...i, basePrice: fromCents(i.basePrice), soldOut: !!(i.soldOut && i.soldOut.flag) })), categories: cats,
    roomTypes: rooms.map((r) => ({ ...r, baseRate: fromCents(r.baseRate) })), branches: branches.filter((b) => canAccessBranch(user, b._id)),
    themes: T.THEMES, slideTypes: T.SLIDE_TYPES, layouts: T.LAYOUTS, badges: T.BADGES, transitions: T.TRANSITIONS, limits: T.LIMITS };
}

// ------------------------------------------------------------------ media
const listMedia = (bid) => TvMedia.find({ businessId: bid }).sort({ createdAt: -1 }).limit(200);
async function addMedia(bid, user, file, name) {
  if (!file || !file.path) throw ApiError.badRequest('Choose an image to upload', 'NO_FILE');
  const m = await TvMedia.create({ businessId: bid, name: name || file.originalname, url: file.path, publicId: file.filename, uploadedBy: user._id });
  await log(bid, user, 'media.add', 'TvMedia', m._id, { name: m.name }); return m;
}
async function removeMedia(bid, user, id) {
  const m = await TvMedia.findOneAndDelete({ _id: id, businessId: bid }); if (!m) throw nf('Image');
  await TvPlaylist.updateMany({ businessId: bid, 'slides.mediaId': m._id }, { $set: { 'slides.$[s].mediaId': null, 'slides.$[s].enabled': false } }, { arrayFilters: [{ 's.mediaId': m._id }] });
  await log(bid, user, 'media.remove', 'TvMedia', m._id); return { deleted: true };
}

// ------------------------------------------------------------------ promotions (advertised AND honoured at checkout)
async function menuItemsOf(bid, ids) {
  const list = (ids || []).map(oid).filter(Boolean);
  const found = await MenuItem.find({ businessId: bid, _id: { $in: list } }).select('_id').lean();
  if (found.length !== new Set(list.map(idStr)).size) throw ApiError.badRequest('One or more menu items do not belong to this business', 'INVALID_ITEMS');
  return list;
}
/** Writes (or removes) the promotion's timed price on every eligible menu item, so the till charges exactly what the TV advertises. */
async function syncPromo(promo) {
  await MenuItem.updateMany({ businessId: promo.businessId, 'timedPrices.promoRef': promo._id }, { $pull: { timedPrices: { promoRef: promo._id } } });
  if (promo.active) {
    const sp = new Map((promo.specialPrices || []).map((p) => [idStr(p.menuItemId), p.price]));
    for (const id of promo.menuItemIds) {
      const entry = { label: promo.title, windows: (promo.windows || []).map((w) => (w.toObject ? w.toObject() : w)), branchIds: promo.branchIds || [], promoRef: promo._id };
      if (promo.mode === 'PERCENT') entry.percentOff = promo.percentOff; else if (sp.has(idStr(id))) entry.price = sp.get(idStr(id)); else continue;
      await MenuItem.updateOne({ _id: id, businessId: promo.businessId }, { $push: { timedPrices: entry } });
    }
  }
  promo.appliedAt = new Date(); await promo.save();
  try { require('../restaurant/menu.service').bustMenu(promo.businessId); } catch (e) { /* cache clears itself in 10s */ }
  push(promo.businessId, 'refresh', { reason: 'promotion' });
}
const listPromos = (bid) => TvPromotion.find({ businessId: bid }).sort({ createdAt: -1 });
async function savePromo(bid, user, input, id) {
  const data = { ...input };
  if (data.menuItemIds) data.menuItemIds = await menuItemsOf(bid, data.menuItemIds);
  if (data.specialPrices) { const ok = new Set((data.menuItemIds || []).map(idStr)); data.specialPrices = data.specialPrices.filter((p) => ok.has(idStr(p.menuItemId))); }
  if (data.branchIds && data.branchIds.length) { const n = await Branch.countDocuments({ businessId: bid, _id: { $in: data.branchIds } }); if (n !== data.branchIds.length) throw ApiError.badRequest('Invalid branch', 'INVALID_BRANCH'); }
  let p;
  if (id) { p = await TvPromotion.findOne({ _id: id, businessId: bid }); if (!p) throw nf('Promotion'); p.set(data); } else p = new TvPromotion({ ...data, businessId: bid, createdBy: user._id });
  if (p.mode === 'PERCENT' && !p.percentOff) throw ApiError.badRequest('Give a percentage off', 'PERCENT_REQUIRED');
  if (p.mode === 'SPECIAL_PRICE' && !(p.specialPrices || []).length) throw ApiError.badRequest('Give a special price for at least one item', 'PRICE_REQUIRED');
  if (!p.menuItemIds.length) throw ApiError.badRequest('Pick at least one menu item', 'ITEMS_REQUIRED');
  await p.save(); await syncPromo(p);
  await log(bid, user, id ? 'promotion.update' : 'promotion.create', 'TvPromotion', p._id, { title: p.title, mode: p.mode, percentOff: p.percentOff, items: p.menuItemIds.length, active: p.active });
  return p;
}
async function togglePromo(bid, user, id, active) {
  const p = await TvPromotion.findOne({ _id: id, businessId: bid }); if (!p) throw nf('Promotion');
  p.active = active; await p.save(); await syncPromo(p); await log(bid, user, active ? 'promotion.on' : 'promotion.off', 'TvPromotion', p._id); return p;
}
async function removePromo(bid, user, id) {
  const p = await TvPromotion.findOne({ _id: id, businessId: bid }); if (!p) throw nf('Promotion');
  p.active = false; await syncPromo(p); await TvPromotion.deleteOne({ _id: p._id });
  await TvPlaylist.updateMany({ businessId: bid, 'slides.promotionId': p._id }, { $set: { 'slides.$[s].enabled': false } }, { arrayFilters: [{ 's.promotionId': p._id }] });
  await log(bid, user, 'promotion.delete', 'TvPromotion', p._id, { title: p.title }); return { deleted: true };
}

// ------------------------------------------------------------------ playlists (draft -> preview -> publish -> rollback)
const listPlaylists = (bid) => TvPlaylist.find({ businessId: bid, status: 'active' }).sort({ name: 1 }).select('-slides');
async function getPlaylist(bid, id) { const p = await TvPlaylist.findOne({ _id: id, businessId: bid, status: 'active' }); if (!p) throw nf('Playlist'); return p; }
async function createPlaylist(bid, user, input) {
  if ((await TvPlaylist.countDocuments({ businessId: bid, status: 'active' })) >= T.LIMITS.PLAYLISTS) throw ApiError.badRequest('Playlist limit reached', 'LIMIT');
  const p = await TvPlaylist.create({ ...input, businessId: bid }); await log(bid, user, 'playlist.create', 'TvPlaylist', p._id, { name: p.name }); return p;
}
async function updatePlaylist(bid, user, id, input) {
  const p = await getPlaylist(bid, id); p.set(input); p.draftVersion += 1; await p.save(); await log(bid, user, 'playlist.update', 'TvPlaylist', p._id, input); return p;
}
async function checkRefs(bid, slides) {
  const ids = (k) => [...new Set(slides.flatMap((s) => s[k] || []).map(idStr))];
  const chk = async (Model, k, extra = {}) => { const l = ids(k); if (l.length && (await Model.countDocuments({ businessId: bid, _id: { $in: l }, ...extra })) !== l.length) throw ApiError.badRequest('A slide refers to something that does not belong to this business', 'INVALID_REFERENCE'); };
  await chk(MenuItem, 'menuItemIds'); await chk(Category, 'categoryIds'); await chk(RoomType, 'roomTypeIds');
  const one = async (Model, k) => { const l = [...new Set(slides.map((s) => s[k]).filter(Boolean).map(idStr))]; if (l.length && (await Model.countDocuments({ businessId: bid, _id: { $in: l } })) !== l.length) throw ApiError.badRequest('A slide refers to something that does not belong to this business', 'INVALID_REFERENCE'); };
  await one(TvPromotion, 'promotionId'); await one(TvMedia, 'mediaId');
}
async function setSlides(bid, user, id, slides) {
  if (slides.length > T.LIMITS.SLIDES) throw ApiError.badRequest(`At most ${T.LIMITS.SLIDES} slides`, 'LIMIT');
  await checkRefs(bid, slides);
  const p = await getPlaylist(bid, id); p.slides = slides; p.draftVersion += 1; await p.save();
  await log(bid, user, 'playlist.slides', 'TvPlaylist', p._id, { slides: slides.length }); return p;
}
async function removePlaylist(bid, user, id) {
  const p = await getPlaylist(bid, id); p.status = 'archived'; await p.save();
  const sc = await TvScreen.find({ businessId: bid, playlistId: p._id }).select('_id'); await TvScreen.updateMany({ businessId: bid, playlistId: p._id }, { $unset: { playlistId: 1 } });
  push(bid, 'refresh', { reason: 'playlist', screenIds: sc.map((s) => idStr(s._id)) }); await log(bid, user, 'playlist.archive', 'TvPlaylist', p._id); return { archived: true };
}
const snapshotOf = (p) => ({ name: p.name, kind: p.kind, orderType: p.orderType, defaultSeconds: p.defaultSeconds, theme: p.theme ? (p.theme.toObject ? p.theme.toObject() : p.theme) : {}, ticker: p.ticker, slides: p.slides.map((s) => s.toObject()) });
async function validateForPublish(bid, p) {
  const live = p.slides.filter((s) => s.enabled !== false);
  if (!live.length) throw ApiError.badRequest('Add and enable at least one slide before publishing', 'EMPTY_PLAYLIST');
  for (const s of live) {
    const bad = (m) => ApiError.badRequest(`Slide "${s.title || s.type}": ${m}`, 'INVALID_SLIDE');
    if (['MENU_ITEMS'].includes(s.type) && !s.menuItemIds.length) throw bad('pick menu items');
    if (s.type === 'CATEGORY' && !s.categoryIds.length) throw bad('pick a category');
    if (s.type === 'PROMO' && !s.promotionId) throw bad('pick a promotion');
    if (s.type === 'MEDIA' && !s.mediaId) throw bad('pick an image');
    if (s.type === 'ROOMS' && !s.roomTypeIds.length) throw bad('pick room types');
    if (s.type === 'TEXT' && !s.text) throw bad('write the message');
  }
  await checkRefs(bid, live);
}
async function publish(bid, user, id, note) {
  const p = await getPlaylist(bid, id); await validateForPublish(bid, p);
  p.publishedVersion += 1; p.publishedAt = new Date(); p.publishedBy = user._id; await p.save();
  await TvPublication.create({ businessId: bid, playlistId: p._id, version: p.publishedVersion, note, publishedBy: user._id, snapshot: snapshotOf(p) });
  const old = await TvPublication.find({ playlistId: p._id }).sort({ version: -1 }).skip(T.LIMITS.HISTORY).select('_id'); if (old.length) await TvPublication.deleteMany({ _id: { $in: old.map((o) => o._id) } });
  await log(bid, user, 'publish', 'TvPlaylist', p._id, { version: p.publishedVersion, note });
  const sc = await TvScreen.find({ businessId: bid, playlistId: p._id, status: 'PAIRED' }).select('_id');
  push(bid, 'refresh', { reason: 'publish', screenIds: sc.map((s) => idStr(s._id)), version: p.publishedVersion });
  return { playlistId: p._id, version: p.publishedVersion, screens: sc.length };
}
const history = (bid, id) => TvPublication.find({ businessId: bid, playlistId: id }).sort({ version: -1 }).select('version note publishedBy createdAt').populate('publishedBy', 'name');
async function rollback(bid, user, id, version) {
  const p = await getPlaylist(bid, id); const pub = await TvPublication.findOne({ businessId: bid, playlistId: p._id, version }); if (!pub) throw nf('That version');
  const s = pub.snapshot; p.set({ name: s.name, kind: s.kind, orderType: s.orderType, defaultSeconds: s.defaultSeconds, theme: s.theme, ticker: s.ticker }); p.slides = s.slides.map(({ _id, ...r }) => r);
  p.draftVersion += 1; await p.save(); await log(bid, user, 'rollback.draft', 'TvPlaylist', p._id, { fromVersion: version });
  return publish(bid, user, id, `Rollback to version ${version}`);
}

// ------------------------------------------------------------------ rendering
const slideLive = (s, now, tz) => s.enabled !== false && (!s.schedule || !Object.values(s.schedule.toObject ? s.schedule.toObject() : s.schedule).some((v) => v && (!Array.isArray(v) || v.length)) || inAnyWindow(now, tz, [s.schedule]));
function resolveTheme(settingsTheme = {}, over = {}) {
  const st = settingsTheme.toObject ? settingsTheme.toObject() : settingsTheme; const o = over && over.toObject ? over.toObject() : over || {};
  const preset = o.preset || st.preset || 'BOLD_RED'; const base = T.THEMES[preset] || T.THEMES.BOLD_RED;
  const pick = (x) => Object.fromEntries(['primary', 'secondary', 'accent', 'text', 'background'].filter((k) => x[k]).map((k) => [k, x[k]]));
  const flag = (k) => (typeof o[k] === 'boolean' ? o[k] : typeof st[k] === 'boolean' ? st[k] : true);
  return { preset, ...base, ...(o.preset ? {} : pick(st)), ...pick(o), showClock: flag('showClock'), showLogo: flag('showLogo'), showTicker: flag('showTicker') };
}
function itemView(it, { orderType, branchId, badges, hideSoldOut }) {
  const be = (it.branchOverrides || []).find((b) => idStr(b.branchId) === idStr(branchId));
  const key = { DINE_IN: 'dineIn', ROOM_SERVICE: 'dineIn', TAKEAWAY: 'takeaway', DELIVERY: 'delivery' }[orderType];
  let base = it.basePrice; if (key && it.typePrices && typeof it.typePrices[key] === 'number') base = it.typePrices[key]; if (be && typeof be.price === 'number') base = be.price;
  const live = it.effectivePrice; const promo = live !== null && live !== undefined && live < base - 0.0001;
  const prices = (it.variants || []).filter((v) => v.active !== false && typeof v.price === 'number').map((v) => v.price + (v.priceDelta || 0));
  const priceFrom = live === null || live === undefined; const price = priceFrom ? (prices.length ? Math.min(...prices) : null) : live;
  const soldOut = !!(it.soldOut && it.soldOut.flag) || it.available === false;
  if (hideSoldOut && soldOut) return null;
  return { id: idStr(it._id), name: it.name, description: it.description || null, image: it.image || null, price, priceFrom, originalPrice: promo ? base : null,
    discountPercent: promo && base ? Math.round(((base - live) / base) * 100) : null, promoLabel: it.promoLabel || null, badge: badges.get(idStr(it._id)) || null,
    isCombo: !!it.isCombo, soldOut, available: it.available !== false, allergens: it.allergens || [] };
}
async function renderPlaylist({ businessId, branchId, snapshot, settings, business, now = new Date(), withSchedule = false }) {
  const tz = business.timezone || 'Africa/Nairobi'; const orderType = snapshot.orderType || 'DINE_IN';
  const menuSvc = require('../restaurant/menu.service');
  let menu = { categories: [] };
  if (snapshot.slides.some((s) => ['MENU_ITEMS', 'CATEGORY', 'PROMO'].includes(s.type))) menu = await menuSvc.getMenu(businessId, SYSTEM, { branchId, orderType });
  const byId = new Map(); const byCat = new Map();
  for (const c of menu.categories) for (const i of c.items) { byId.set(idStr(i._id), { ...i, categoryName: c.name }); const k = idStr(c._id || 'none'); if (!byCat.has(k)) byCat.set(k, []); byCat.get(k).push(byId.get(idStr(i._id))); }
  const out = []; const skipped = [];
  for (const s of snapshot.slides) {
    const live = slideLive(s, now, tz);
    if (!live && !(withSchedule && s.enabled !== false)) continue;      // withSchedule: also render slides that are not live yet, so an offline screen can switch dayparts by itself
    const badges = new Map((s.badges || []).map((b) => [idStr(b.menuItemId), b.badge]));
    const ctx = { orderType, branchId, badges, hideSoldOut: settings.hideSoldOut };
    const base = { id: idStr(s._id), type: s.type, layout: s.layout, title: s.title || null, subtitle: s.subtitle || null, durationSec: s.durationSec || snapshot.defaultSeconds || 12, transition: s.transition || 'FADE' };
    const lim = s.limit || T.LIMITS.ITEMS_PER_SLIDE; let slide = null;
    if (s.type === 'MENU_ITEMS') {
      const items = (s.menuItemIds || []).map((id) => byId.get(idStr(id))).filter(Boolean).map((i) => itemView(i, ctx)).filter(Boolean).slice(0, lim);
      if (items.length) slide = { ...base, items };
    } else if (s.type === 'CATEGORY') {
      const items = (s.categoryIds || []).flatMap((c) => byCat.get(idStr(c)) || []).map((i) => itemView(i, ctx)).filter(Boolean).slice(0, lim);
      if (items.length) slide = { ...base, items };
    } else if (s.type === 'PROMO') {
      const pr = await TvPromotion.findOne({ _id: s.promotionId, businessId }).lean();
      if (pr && pr.active && inAnyWindow(now, tz, pr.windows) && (!pr.branchIds.length || pr.branchIds.some((b) => idStr(b) === idStr(branchId)))) {
        const items = pr.menuItemIds.map((id) => byId.get(idStr(id))).filter(Boolean).map((i) => itemView(i, ctx)).filter(Boolean).slice(0, lim);
        if (items.length) slide = { ...base, title: base.title || pr.title, subtitle: base.subtitle || pr.description || null, promo: { title: pr.title, percentOff: pr.mode === 'PERCENT' ? pr.percentOff : null }, items };
      }
    } else if (s.type === 'MEDIA') {
      const m = await TvMedia.findOne({ _id: s.mediaId, businessId }).lean(); if (m) slide = { ...base, media: { url: m.url, name: m.name } };
    } else if (s.type === 'ROOMS') {
      if (business.featureSettings && business.featureSettings.accommodation === true) {
        const rts = await RoomType.find({ businessId, active: true, _id: { $in: s.roomTypeIds } }).lean(); const today = now.toISOString().slice(0, 10);
        const rooms = rts.slice(0, lim).map((r) => { const pr = r.promo || {}; const live = !!(pr.active && pr.percentOff > 0 && (!pr.validFrom || today >= pr.validFrom) && (!pr.validTo || today <= pr.validTo));
          const rate = fromCents(r.baseRate); return { id: idStr(r._id), name: r.name, description: r.description || null, image: (r.images || [])[0] || null, perNight: live ? Math.round(rate * (100 - pr.percentOff)) / 100 : rate, originalPerNight: live ? rate : null, promoTitle: live ? pr.title || null : null, discountPercent: live ? pr.percentOff : null }; });
        if (rooms.length) slide = { ...base, rooms };
      }
    } else if (s.type === 'TEXT') slide = { ...base, text: s.text };
    if (slide) {
      if (withSchedule) { const sc = s.schedule && (s.schedule.toObject ? s.schedule.toObject() : s.schedule); const has = sc && Object.values(sc).some((v) => v && (!Array.isArray(v) || v.length)); slide.live = live; slide.schedule = has ? sc : null; }
      out.push(slide);
    } else skipped.push(base.id);
  }
  return { slides: out, skipped };
}
async function buildContent(screen) {
  const bid = screen.businessId; const now = new Date();
  const [business, settings] = await Promise.all([Business.findById(bid).select('name logo currency timezone featureSettings status').lean(), getSettings(bid)]);
  if (!business || business.status !== 'active') throw ApiError.forbidden('Business inactive', 'BUSINESS_INACTIVE');
  const meta = { id: idStr(screen._id), name: screen.name, blackout: !!screen.blackout, command: screen.command && screen.command.type ? screen.command : null, announcement: screen.announcement && screen.announcement.text && screen.announcement.until > now ? { text: screen.announcement.text, until: screen.announcement.until } : null };
  const head = { screen: meta, business: { name: business.name, logo: business.logo || null, currency: business.currency || 'KES', timezone: business.timezone || 'Africa/Nairobi', tagline: settings.tagline || null }, currencyDisplay: settings.currencyDisplay, generatedAt: now, pollSeconds: 30 };
  const pl = screen.playlistId && await TvPlaylist.findOne({ _id: screen.playlistId, businessId: bid, status: 'active' }).lean();
  const pub = pl && pl.publishedVersion ? await TvPublication.findOne({ playlistId: pl._id, version: pl.publishedVersion }).lean() : null;
  if (!pub) return { ...head, version: 0, theme: resolveTheme(settings.theme), ticker: settings.ticker || null, slides: [], empty: 'NOT_PUBLISHED' };
  const snap = pub.snapshot; snap.slides = snap.slides.map((s) => ({ ...s, schedule: s.schedule }));
  const { slides: all } = await renderPlaylist({ businessId: bid, branchId: screen.branchId, snapshot: { ...snap, slides: snap.slides.map((s) => ({ ...s, toObject: undefined })) }, settings, business, now, withSchedule: true });
  const slides = all.filter((x) => x.live !== false).map(({ live, schedule, ...rest }) => rest);
  // Scheduled slides (breakfast, happy hour...): ship every one with its time window so a screen that LOSES THE INTERNET still switches by itself.
  const offlineSlides = all.some((x) => x.schedule) ? all.map(({ live, ...rest }) => rest) : undefined;
  return { ...head, version: pl.publishedVersion, theme: resolveTheme(settings.theme, snap.theme), ticker: snap.ticker || settings.ticker || null, slides, ...(offlineSlides ? { offlineSlides } : {}), empty: slides.length ? null : 'NOTHING_TO_SHOW' };
}
/** Manager preview of the DRAFT (never visible on a TV). */
async function previewDraft(bid, user, id, branchId) {
  assertBranchAccess(user, branchId); const p = await getPlaylist(bid, id);
  const [business, settings] = await Promise.all([Business.findById(bid).select('name logo currency timezone featureSettings').lean(), getSettings(bid)]);
  const snap = snapshotOf(p); const { slides, skipped } = await renderPlaylist({ businessId: bid, branchId, snapshot: snap, settings, business });
  return { draft: true, version: p.draftVersion, business: { name: business.name, logo: business.logo || null, currency: business.currency }, theme: resolveTheme(settings.theme, snap.theme), ticker: snap.ticker || settings.ticker || null, slides, skippedSlideIds: skipped };
}

// ------------------------------------------------------------------ screens (manager side)
const stateOf = (s, now = Date.now()) => (s.status !== 'PAIRED' ? s.status : !s.lastSeenAt ? 'NEVER_CONNECTED' : now - s.lastSeenAt <= T.LIMITS.OFFLINE_AFTER_SEC * 1000 ? 'ONLINE' : 'OFFLINE');
const screenView = (s, pl) => ({ id: s._id, name: s.name, branchId: s.branchId, playlistId: s.playlistId || null, playlistName: pl ? pl.name : null, status: s.status, connection: stateOf(s), pairedAt: s.pairedAt, lastSeenAt: s.lastSeenAt,
  shownVersion: s.shownVersion ?? null, publishedVersion: pl ? pl.publishedVersion : null, outdated: !!(pl && s.status === 'PAIRED' && s.shownVersion != null && s.shownVersion !== pl.publishedVersion), blackout: s.blackout, lastError: s.lastError && s.lastError.message ? s.lastError : null, errorCount: s.errorCount, pairingPending: s.status === 'PENDING' && s.pairExpiresAt > new Date() });
async function listScreens(bid, user) {
  const q = { businessId: bid }; if (![ROLES.OWNER, ROLES.ADMIN].includes(user.role)) q.branchId = { $in: user.branchIds || [] };
  const [rows, pls] = await Promise.all([TvScreen.find(q).sort({ name: 1 }).lean(), TvPlaylist.find({ businessId: bid }).select('name publishedVersion').lean()]);
  const m = new Map(pls.map((p) => [idStr(p._id), p])); return rows.map((s) => screenView(s, m.get(idStr(s.playlistId))));
}
async function loadScreen(bid, user, id) { const s = await TvScreen.findOne({ _id: id, businessId: bid }); if (!s) throw nf('Screen'); assertBranchAccess(user, s.branchId); return s; }
async function checkLinks(bid, branchId, playlistId) {
  if (branchId && !(await Branch.exists({ _id: branchId, businessId: bid }))) throw ApiError.badRequest('Invalid branch', 'INVALID_BRANCH');
  if (playlistId && !(await TvPlaylist.exists({ _id: playlistId, businessId: bid, status: 'active' }))) throw ApiError.badRequest('Invalid playlist', 'INVALID_PLAYLIST');
}
async function issueCode(s) { const code = makeCode(); s.pairCodeHash = sha(code); s.pairExpiresAt = new Date(Date.now() + T.LIMITS.PAIR_MINUTES * 60000); s.pairAttempts = 0; await s.save(); return { code: prettyCode(code), expiresAt: s.pairExpiresAt }; }
async function createScreen(bid, user, input) {
  assertBranchAccess(user, input.branchId); await checkLinks(bid, input.branchId, input.playlistId);
  if ((await TvScreen.countDocuments({ businessId: bid, status: { $ne: 'REVOKED' } })) >= T.LIMITS.SCREENS) throw ApiError.badRequest('Screen limit reached', 'LIMIT');
  const s = new TvScreen({ ...input, businessId: bid }); const pair = await issueCode(s);
  await log(bid, user, 'screen.create', 'TvScreen', s._id, { name: s.name }, s.branchId); return { screen: screenView(s), pairing: pair };
}
async function updateScreen(bid, user, id, input) {
  const s = await loadScreen(bid, user, id); if (input.branchId) assertBranchAccess(user, input.branchId); await checkLinks(bid, input.branchId, input.playlistId);
  s.set(input); await s.save(); push(bid, 'refresh', { reason: 'screen', screenIds: [idStr(s._id)] }); await log(bid, user, 'screen.update', 'TvScreen', s._id, input, s.branchId); return screenView(s);
}
async function newPairCode(bid, user, id) {
  const s = await loadScreen(bid, user, id); s.status = 'PENDING'; s.tokenHash = undefined; const pair = await issueCode(s);
  push(bid, 'revoked', { screenIds: [idStr(s._id)] }); await log(bid, user, 'screen.repair', 'TvScreen', s._id, null, s.branchId); return { pairing: pair };
}
async function setScreenStatus(bid, user, id, status) {
  const s = await loadScreen(bid, user, id); s.status = status; if (status === 'REVOKED') { s.tokenHash = undefined; s.pairCodeHash = undefined; } await s.save();
  push(bid, status === 'PAIRED' ? 'refresh' : 'revoked', { screenIds: [idStr(s._id)] }); await log(bid, user, `screen.${status.toLowerCase()}`, 'TvScreen', s._id, null, s.branchId); return screenView(s);
}
async function enableScreen(bid, user, id) { const s = await loadScreen(bid, user, id); if (!s.tokenHash) throw ApiError.badRequest('Pair this screen first', 'NOT_PAIRED'); return setScreenStatus(bid, user, id, 'PAIRED'); }
async function command(bid, user, id, { type, blackout }) {
  const s = await loadScreen(bid, user, id);
  if (type === 'BLACKOUT') { s.blackout = !!blackout; } else s.command = { type, at: new Date() };
  await s.save(); push(bid, 'command', { screenIds: [idStr(s._id)], type, blackout: s.blackout }); await log(bid, user, `screen.${type.toLowerCase()}`, 'TvScreen', s._id, { blackout }, s.branchId); return screenView(s);
}
async function announce(bid, user, id, { text, minutes }) {
  const s = await loadScreen(bid, user, id); s.announcement = text ? { text, until: new Date(Date.now() + minutes * 60000) } : { text: undefined, until: undefined }; await s.save();
  push(bid, 'refresh', { reason: 'announcement', screenIds: [idStr(s._id)] }); await log(bid, user, 'screen.announce', 'TvScreen', s._id, { text }, s.branchId); return screenView(s);
}
async function overview(bid, user) {
  const screens = await listScreens(bid, user); const c = (k) => screens.filter((s) => s.connection === k).length;
  const [playlists, promos, recent] = await Promise.all([TvPlaylist.countDocuments({ businessId: bid, status: 'active' }), TvPromotion.find({ businessId: bid }).select('active title windows').lean(), AuditLog.find({ businessId: bid, action: /^tv\./ }).sort({ timestamp: -1 }).limit(15).select('action userId timestamp newValue').populate('userId', 'name').lean()]);
  return { screens: { total: screens.length, online: c('ONLINE'), offline: c('OFFLINE'), neverConnected: c('NEVER_CONNECTED'), pending: c('PENDING'), outdated: screens.filter((s) => s.outdated).length, withErrors: screens.filter((s) => s.lastError).length }, playlists, promotions: { total: promos.length, active: promos.filter((p) => p.active).length }, recentActivity: recent, streams: hub.listeners(chan(bid)) };
}
async function removeScreen(bid, user, id) { const s = await loadScreen(bid, user, id); await TvScreen.deleteOne({ _id: s._id }); push(bid, 'revoked', { screenIds: [idStr(s._id)] }); await log(bid, user, 'screen.delete', 'TvScreen', s._id, { name: s.name }, s.branchId); return { deleted: true }; }
const audit = (bid, limit = 50) => AuditLog.find({ businessId: bid, action: /^tv\./ }).sort({ timestamp: -1 }).limit(limit).populate('userId', 'name').lean();

// ------------------------------------------------------------------ public side (the TV itself)
async function pair(code, meta) {
  const c = normCode(code); if (c.length !== 8) throw ApiError.badRequest('Enter the 8-character code shown in the POS', 'BAD_CODE');
  const s = await TvScreen.findOne({ pairCodeHash: sha(c), status: 'PENDING', pairExpiresAt: { $gt: new Date() } });
  if (!s) throw ApiError.badRequest('That code is wrong or has expired. Generate a new one in the POS.', 'BAD_CODE');
  const secret = crypto.randomBytes(32).toString('base64url');
  s.tokenHash = sha(secret); s.pairCodeHash = undefined; s.pairExpiresAt = undefined; s.status = 'PAIRED'; s.pairedAt = new Date(); s.lastSeenAt = new Date(); s.lastIp = meta.ip; s.userAgent = String(meta.ua || '').slice(0, 200); await s.save();
  await log(s.businessId, null, 'screen.paired', 'TvScreen', s._id, { name: s.name }, s.branchId); push(s.businessId, 'paired', { screenId: idStr(s._id) });
  return { token: `${s._id}.${secret}`, screenId: s._id, name: s.name };
}
async function authDevice(token) {
  const [id, secret] = String(token || '').split('.'); const bad = () => ApiError.unauthorized('This screen is not authorised. Pair it again.', 'TV_UNAUTHORIZED');
  if (!oid(id) || !secret) throw bad();
  const s = await TvScreen.findById(id); if (!s || !s.tokenHash || !eq(s.tokenHash, sha(secret))) throw bad();
  if (s.status !== 'PAIRED') throw ApiError.forbidden(s.status === 'DISABLED' ? 'This screen was switched off by a manager.' : 'This screen was revoked.', `TV_${s.status}`);
  return s;
}
async function touch(s, { ip, ua, shownVersion, appVersion }) {
  const set = { lastSeenAt: new Date(), lastIp: ip }; if (shownVersion != null) set.shownVersion = shownVersion; if (appVersion) set.appVersion = String(appVersion).slice(0, 30); if (ua) set.userAgent = String(ua).slice(0, 200);
  const unset = s.command && s.command.type ? { command: 1 } : null; await TvScreen.updateOne({ _id: s._id }, unset ? { $set: set, $unset: unset } : { $set: set });
}
const etagOf = (c) => sha(JSON.stringify({ ...c, generatedAt: 0 })).slice(0, 16);
async function content(s, meta, ifEtag) {
  const c = await buildContent(s); const etag = etagOf(c); await touch(s, { ...meta, shownVersion: meta.shownVersion });
  if (ifEtag && ifEtag === etag) return { unchanged: true, etag, pollSeconds: c.pollSeconds };
  return { ...c, etag };
}
async function heartbeat(s, meta) { await touch(s, meta); return { ok: true, serverTime: new Date() }; }
async function reportError(s, message) { await TvScreen.updateOne({ _id: s._id }, { $set: { lastError: { message: String(message).slice(0, 300), at: new Date() } }, $inc: { errorCount: 1 } }); return { ok: true }; }
function stream(s, req, res) {
  const id = idStr(s._id);
  return hub.subscribe(chan(s.businessId), req, res, { hello: { screenId: id }, filter: (d) => !d.screenIds || d.screenIds.includes(id) });
}
/** Cron: remove expired announcements. (Offline state is computed from lastSeenAt on read, so nothing else needs sweeping.) */
async function sweep() { await TvScreen.updateMany({ 'announcement.until': { $lt: new Date() } }, { $unset: { announcement: 1 } }); }

module.exports = { getSettings, updateSettings, options, listMedia, addMedia, removeMedia, listPromos, savePromo, togglePromo, removePromo, listPlaylists, getPlaylist, createPlaylist, updatePlaylist, setSlides, removePlaylist,
  publish, history, rollback, previewDraft, listScreens, createScreen, updateScreen, newPairCode, setScreenStatus, enableScreen, command, announce, overview, removeScreen, audit,
  pair, authDevice, content, heartbeat, reportError, stream, sweep, menuChanged, buildContent, resolveTheme };
