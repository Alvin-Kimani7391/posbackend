/** All Live TV models in one file (each exported separately from the model files that re-export them). */
const { Schema, model, models } = require('mongoose');
const T = require('../constants/tv');
const oid = (ref, extra = {}) => ({ type: Schema.Types.ObjectId, ref, ...extra });
const hex = { type: String, match: T.HEX };
const schedule = new Schema({ days: { type: [Number], default: undefined }, start: String, end: String, startDate: String, endDate: String }, { _id: false });
const theme = new Schema({ preset: { type: String, enum: T.THEME_KEYS }, primary: hex, secondary: hex, accent: hex, text: hex, background: hex,
  showClock: Boolean, showLogo: Boolean, showTicker: Boolean }, { _id: false });

const slide = new Schema({
  type: { type: String, enum: T.SLIDE_TYPES, required: true },
  layout: { type: String, enum: T.LAYOUTS, default: 'GRID' },
  title: { type: String, trim: true, maxlength: 80 }, subtitle: { type: String, trim: true, maxlength: 160 },
  durationSec: { type: Number, min: T.LIMITS.SLIDE_SECONDS.min, max: T.LIMITS.SLIDE_SECONDS.max },
  transition: { type: String, enum: T.TRANSITIONS },
  enabled: { type: Boolean, default: true },
  schedule,
  menuItemIds: [oid('MenuItem')], categoryIds: [oid('Category')], roomTypeIds: [oid('RoomType')],
  promotionId: oid('TvPromotion'), mediaId: oid('TvMedia'), text: { type: String, trim: true, maxlength: 400 },
  limit: { type: Number, min: 1, max: T.LIMITS.ITEMS_PER_SLIDE },
  badges: [{ _id: false, menuItemId: oid('MenuItem'), badge: { type: String, enum: T.BADGES } }],
}, { _id: true });

const playlistSchema = new Schema({
  businessId: oid('Business', { required: true, index: true }),
  name: { type: String, required: true, trim: true, maxlength: 80 },
  kind: { type: String, enum: ['RESTAURANT', 'GUEST'], default: 'RESTAURANT' },
  orderType: { type: String, enum: ['DINE_IN', 'TAKEAWAY', 'DELIVERY', 'ROOM_SERVICE'], default: 'DINE_IN' },
  defaultSeconds: { type: Number, default: 12, min: 4, max: 120 },
  theme, ticker: { type: String, trim: true, maxlength: 240 },
  slides: { type: [slide], default: [] },          // DRAFT: the TV never sees this until published
  draftVersion: { type: Number, default: 1 },
  publishedVersion: { type: Number, default: 0 },
  publishedAt: Date, publishedBy: oid('User'),
  status: { type: String, enum: ['active', 'archived'], default: 'active' },
}, { timestamps: true });
playlistSchema.index({ businessId: 1, name: 1 });

const publicationSchema = new Schema({
  businessId: oid('Business', { required: true, index: true }), playlistId: oid('Playlist', { required: true }),
  version: { type: Number, required: true }, note: String, publishedBy: oid('User'),
  snapshot: Schema.Types.Mixed,                    // { name, kind, orderType, defaultSeconds, theme, ticker, slides: [...] }
}, { timestamps: true });
publicationSchema.index({ playlistId: 1, version: -1 });

const promoSchema = new Schema({
  businessId: oid('Business', { required: true, index: true }),
  title: { type: String, required: true, trim: true, maxlength: 80 }, description: { type: String, trim: true, maxlength: 240 },
  mode: { type: String, enum: ['PERCENT', 'SPECIAL_PRICE'], required: true },
  percentOff: { type: Number, min: 1, max: 90 },
  specialPrices: [{ _id: false, menuItemId: oid('MenuItem'), price: { type: Number, min: 0 } }],   // integer cents
  menuItemIds: [oid('MenuItem')], branchIds: [oid('Branch')], windows: [schedule],
  active: { type: Boolean, default: true },
  appliedAt: Date,
  createdBy: oid('User'),
}, { timestamps: true });

const mediaSchema = new Schema({
  businessId: oid('Business', { required: true, index: true }), name: { type: String, trim: true, maxlength: 80 },
  url: { type: String, required: true }, publicId: String, kind: { type: String, enum: ['IMAGE'], default: 'IMAGE' }, uploadedBy: oid('User'),
}, { timestamps: true });

const settingsSchema = new Schema({
  businessId: oid('Business', { required: true, unique: true }),
  theme: { type: theme, default: () => ({ preset: 'BOLD_RED', showClock: true, showLogo: true, showTicker: true }) },
  ticker: { type: String, trim: true, maxlength: 240 }, tagline: { type: String, trim: true, maxlength: 80 },
  currencyDisplay: { type: String, enum: ['SYMBOL', 'CODE', 'NONE'], default: 'CODE' },
  hideSoldOut: { type: Boolean, default: false },
}, { timestamps: true });

const screenSchema = new Schema({
  businessId: oid('Business', { required: true, index: true }), branchId: oid('Branch', { required: true }),
  name: { type: String, required: true, trim: true, maxlength: 60 },
  playlistId: oid('Playlist'),
  status: { type: String, enum: ['PENDING', 'PAIRED', 'REVOKED', 'DISABLED'], default: 'PENDING' },
  pairCodeHash: String, pairExpiresAt: Date, pairAttempts: { type: Number, default: 0 },
  tokenHash: { type: String, index: true }, pairedAt: Date,
  lastSeenAt: Date, lastIp: String, userAgent: String, shownVersion: Number, appVersion: String,
  lastError: { message: String, at: Date },
  errorCount: { type: Number, default: 0 },
  command: { type: { type: String }, at: Date },    // last remote command: RELOAD / BLACKOUT / WAKE
  blackout: { type: Boolean, default: false },
  announcement: { text: String, until: Date },      // "Order 45 is ready" style overlay
}, { timestamps: true });
screenSchema.index({ businessId: 1, branchId: 1 });

const reg = (n, s) => models[n] || model(n, s);
module.exports = {
  TvPlaylist: reg('TvPlaylist', playlistSchema), TvPublication: reg('TvPublication', publicationSchema), TvPromotion: reg('TvPromotion', promoSchema),
  TvMedia: reg('TvMedia', mediaSchema), TvSettings: reg('TvSettings', settingsSchema), TvScreen: reg('TvScreen', screenSchema),
};
