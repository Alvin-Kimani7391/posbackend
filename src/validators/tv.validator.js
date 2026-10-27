const { z } = require('zod');
const T = require('../constants/tv');
const { objectId } = require('./common');
const str = (n = 200) => z.string().trim().max(n);
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/); const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hex = z.string().regex(T.HEX);
const cents = z.coerce.number().min(0).transform((v) => Math.round(v * 100));
const schedule = z.object({ days: z.array(z.number().int().min(0).max(6)).optional(), start: hhmm.optional(), end: hhmm.optional(), startDate: ymd.optional(), endDate: ymd.optional() }).strict();
const theme = z.object({ preset: z.enum(T.THEME_KEYS), primary: hex, secondary: hex, accent: hex, text: hex, background: hex, showClock: z.boolean(), showLogo: z.boolean(), showTicker: z.boolean() }).partial().strict();
const ordersCfg = z.object({ style: z.enum(T.ORDER_STYLES), showItems: z.boolean(), showTable: z.boolean(), showCustomer: z.boolean(), showTime: z.boolean(), maxOrders: z.coerce.number().int().min(3).max(24), orderTypes: z.array(z.enum(T.ORDER_TYPES)).max(7) }).partial().strict();
const ordersPanel = z.object({ enabled: z.boolean(), position: z.enum(T.ORDER_PANEL_POSITIONS), maxOrders: z.coerce.number().int().min(3).max(16) }).partial().strict();
const idParam = z.object({ id: objectId });

const settingsBody = z.object({ theme: theme.optional(), ticker: str(240).optional(), tagline: str(80).optional(), currencyDisplay: z.enum(['SYMBOL', 'CODE', 'NONE']).optional(), hideSoldOut: z.boolean().optional() }).strict();
const slide = z.object({
  type: z.enum(T.SLIDE_TYPES), layout: z.enum(T.LAYOUTS).optional(), title: str(80).optional(), subtitle: str(160).optional(),
  durationSec: z.coerce.number().min(T.LIMITS.SLIDE_SECONDS.min).max(T.LIMITS.SLIDE_SECONDS.max).optional(), transition: z.enum(T.TRANSITIONS).optional(), enabled: z.boolean().optional(),
  schedule: schedule.optional(), menuItemIds: z.array(objectId).max(60).optional(), categoryIds: z.array(objectId).max(20).optional(), roomTypeIds: z.array(objectId).max(20).optional(),
  promotionId: objectId.optional(), mediaId: objectId.optional(), text: str(400).optional(), limit: z.coerce.number().int().min(1).max(T.LIMITS.ITEMS_PER_SLIDE).optional(),
  badges: z.array(z.object({ menuItemId: objectId, badge: z.enum(T.BADGES) })).max(60).optional(),
  orders: ordersCfg.optional(),
}).strict();
const playlistBody = z.object({ name: str(80).min(1), kind: z.enum(['RESTAURANT', 'GUEST']).optional(), orderType: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY', 'ROOM_SERVICE']).optional(), defaultSeconds: z.coerce.number().int().min(4).max(120).optional(), theme: theme.optional(), ticker: str(240).optional(), ordersPanel: ordersPanel.optional(), slides: z.array(slide).max(T.LIMITS.SLIDES).optional() }).strict();
const playlistUpdate = playlistBody.omit({ slides: true }).partial();
const slidesBody = z.object({ slides: z.array(slide).max(T.LIMITS.SLIDES) }).strict();
const publishBody = z.object({ note: str(200).optional() }).strict();
const rollbackBody = z.object({ version: z.coerce.number().int().min(1) }).strict();
const previewQuery = z.object({ branchId: objectId });

const promoBase = z.object({ title: str(80).min(1), description: str(240).optional(), mode: z.enum(['PERCENT', 'SPECIAL_PRICE']), percentOff: z.coerce.number().min(1).max(90).optional(),
  specialPrices: z.array(z.object({ menuItemId: objectId, price: cents })).max(60).optional(), menuItemIds: z.array(objectId).min(1).max(60), branchIds: z.array(objectId).max(50).optional(),
  windows: z.array(schedule).max(10).optional(), active: z.boolean().optional() }).strict();
const promoBody = promoBase; const promoUpdate = promoBase.partial();
const toggleBody = z.object({ active: z.boolean() }).strict();

const screenBody = z.object({ name: str(60).min(1), branchId: objectId, playlistId: objectId.optional() }).strict();
const screenUpdate = z.object({ name: str(60).min(1).optional(), branchId: objectId.optional(), playlistId: objectId.nullable().optional() }).strict();
const commandBody = z.object({ type: z.enum(['RELOAD', 'BLACKOUT']), blackout: z.boolean().optional() }).strict();
const announceBody = z.object({ text: str(140).optional(), minutes: z.coerce.number().int().min(1).max(240).default(10) }).strict();
const mediaQuery = z.object({}).passthrough();

const pairBody = z.object({ code: str(20).min(8) }).strict();
const beat = z.object({ shownVersion: z.coerce.number().int().min(0).optional(), appVersion: str(30).optional() }).strict();
const errBody = z.object({ message: str(300).min(1) }).strict();
module.exports = { idParam, settingsBody, playlistBody, playlistUpdate, slidesBody, publishBody, rollbackBody, previewQuery, promoBody, promoUpdate, toggleBody, screenBody, screenUpdate, commandBody, announceBody, mediaQuery, pairBody, beat, errBody };
