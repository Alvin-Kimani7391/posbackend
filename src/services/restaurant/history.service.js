/**
 * History + search over everything that has already happened. Read-only; it never changes an order, bill, request or call.
 *   orders()      every restaurant order with many filters (Orders page, Sales report "All orders", QR / kiosk history)
 *   deliveries()  past deliveries and pickups (Delivery & pickup page)
 *   guest()       past guest QR requests and "call waiter" calls (Guest requests & QR page)
 * Money: documents go out through toJSON (already decimal KES); lean / aggregate rows are converted here with fromCents.
 */
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const GuestRequest = require('../../models/GuestRequest');
const ServiceCall = require('../../models/ServiceCall');
const Branch = require('../../models/Branch');
const { fromCents: k, toCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');
const C = require('./common');

const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const rx = (s) => new RegExp(C.escapeRegex(s), 'i');
const terms = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
const r1 = (n) => Math.round(n * 10) / 10;
const NOT_CANCELLED = { $cond: [{ $ne: ['$status', 'CANCELLED'] }, '$totals.total', 0] };

const SELECT = [
  'branchId', 'orderNumber', 'pickupNumber', 'orderType', 'source', 'status', 'billStatus', 'tableName', 'roomNumber', 'waiterId', 'waiterName', 'customerName', 'customerPhone', 'guestCount', 'notes',
  'totals', 'createdAt', 'closedAt', 'cancelledAt', 'cancelReason', 'firstSentAt', 'pickup', 'selfService.paymentState', 'selfService.paymentMethod', 'selfService.paidAt', 'selfService.confirmedByName',
  'items.name', 'items.variantName', 'items.quantity', 'items.unitPrice', 'items.status', 'items.notes', 'items.isComplimentary',
  'delivery.contactName', 'delivery.phone', 'delivery.address', 'delivery.landmark', 'delivery.instructions', 'delivery.fee', 'delivery.payment', 'delivery.online', 'delivery.riderId', 'delivery.riderName',
  'delivery.riderPhone', 'delivery.status', 'delivery.assignedAt', 'delivery.outForDeliveryAt', 'delivery.deliveredAt', 'delivery.failReason', 'delivery.etaMinutes', 'delivery.distanceKm', 'delivery.rating',
].join(' ');

const DATE_PATH = { createdAt: 'createdAt', closedAt: 'closedAt', deliveredAt: 'delivery.deliveredAt', collectedAt: 'pickup.collectedAt' };
const SEARCH_FIELDS = ['orderNumber', 'pickupNumber', 'tableName', 'roomNumber', 'customerName', 'customerPhone', 'waiterName', 'notes', 'cancelReason', 'items.name', 'delivery.contactName', 'delivery.phone', 'delivery.address', 'delivery.landmark', 'delivery.riderName', 'delivery.failReason', 'pickup.collectedBy', 'selfService.publicCode'];

/** Builds the Mongo filter. mode: 'orders' (own-orders rule for waiters) | 'report' (everything the caller may see) | 'delivery' (riders see only their own). */
async function buildFilter(businessId, user, q, mode) {
  const bid = C.oid(businessId);
  const f = { businessId: bid, ...C.branchFilter(C.branchScope(user, q.branchId)) };
  const and = [];
  const types = csv(q.orderType); if (types.length) f.orderType = { $in: types };
  const sources = csv(q.source); if (sources.length) f.source = { $in: sources };
  const sts = csv(q.status); if (sts.length) f.status = { $in: sts };
  const bs = csv(q.billStatus); if (bs.length) f.billStatus = { $in: bs };
  const ds = csv(q.deliveryStatus); if (ds.length) f['delivery.status'] = { $in: ds };
  if (q.tableId) f.tableId = C.oid(q.tableId);
  if (q.waiterId) f.waiterId = C.oid(q.waiterId);
  if (q.riderId) f['delivery.riderId'] = C.oid(q.riderId);
  if (q.from || q.to) { const p = DATE_PATH[q.dateField || 'createdAt']; f[p] = {}; if (q.from) f[p].$gte = new Date(q.from); if (q.to) f[p].$lte = new Date(q.to); }
  if (q.minTotal != null || q.maxTotal != null) { f['totals.total'] = {}; if (q.minTotal != null) f['totals.total'].$gte = toCents(q.minTotal); if (q.maxTotal != null) f['totals.total'].$lte = toCents(q.maxTotal); }

  // presets used by the other pages
  if (q.scope === 'delivery') f.orderType = { $in: ['DELIVERY'] };
  if (q.scope === 'pickup') f.orderType = { $in: ['PICKUP', 'TAKEAWAY'] };
  if (q.scope === 'qr' && !sources.length) f.source = { $in: ['QR_TABLE', 'QR_ROOM'] };
  if (q.scope === 'qr' && sources.length) f.source = { $in: sources.filter((x) => ['QR_TABLE', 'QR_ROOM'].includes(x)) };
  if (q.scope === 'kiosk') f.source = { $in: ['KIOSK'] };
  if (q.outcome && q.outcome !== 'ALL') {
    if (q.outcome === 'DONE') and.push({ $or: [{ orderType: 'DELIVERY', 'delivery.status': 'DELIVERED' }, { orderType: { $in: ['PICKUP', 'TAKEAWAY'] }, 'pickup.status': 'COLLECTED' }] });
    if (q.outcome === 'FAILED') and.push({ orderType: 'DELIVERY', 'delivery.status': 'FAILED' });
    if (q.outcome === 'CANCELLED') f.status = 'CANCELLED';
    if (q.outcome === 'ACTIVE') f.status = 'OPEN';
  }

  // payment method: orders that have a bill with a payment of that method
  const pm = csv(q.paymentMethod);
  if (pm.length) { const ids = await RestaurantBill.distinct('orderId', { businessId: bid, 'payments.method': { $in: pm } }); and.push({ _id: { $in: ids } }); }

  // search: every word must match something (order, table, customer, phone, rider, address, item, bill number...)
  for (const t of terms(q.search)) {
    const r = rx(t);
    const billOrders = await RestaurantBill.distinct('orderId', { businessId: bid, $or: [{ billNumber: r }, { receiptNumber: r }, { 'payments.reference': r }] });
    and.push({ $or: [...SEARCH_FIELDS.map((p) => ({ [p]: r })), ...(billOrders.length ? [{ _id: { $in: billOrders } }] : [])] });
  }

  if (mode === 'orders' && (!C.can(user, 'restaurant.orders.view_all') || q.mine === '1')) {
    const me = C.oid(user._id);
    and.push({ $or: [{ waiterId: me }, { openedBy: me }, ...(q.mine === '1' ? [] : [{ waiterId: { $exists: false } }])] });
  }
  if (mode === 'delivery' && !C.can(user, 'restaurant.delivery.view')) { f['delivery.riderId'] = C.oid(user._id); f.orderType = 'DELIVERY'; }
  if (and.length) f.$and = and;
  return f;
}

const SORTS = { newest: { createdAt: -1 }, oldest: { createdAt: 1 }, highest: { 'totals.total': -1, createdAt: -1 }, lowest: { 'totals.total': 1, createdAt: -1 }, number: { orderNumber: 1 } };

async function shapeOrders(businessId, docs) {
  const ids = docs.map((d) => d._id);
  const [bills, branches] = await Promise.all([
    ids.length ? RestaurantBill.find({ businessId, orderId: { $in: ids } }).select('orderId billNumber receiptNumber status total paid balance payments.method payments.amount payments.kind payments.reference').lean() : [],
    Branch.find({ _id: { $in: [...new Set(docs.map((d) => String(d.branchId)))] }, businessId }).select('name').lean(),
  ]);
  const bn = new Map(branches.map((b) => [String(b._id), b.name]));
  const by = new Map();
  bills.forEach((b) => {
    const key = String(b.orderId); const row = by.get(key) || { bills: [], methods: new Set(), total: 0, paid: 0, balance: 0 };
    row.bills.push({ billNumber: b.billNumber, receiptNumber: b.receiptNumber, status: b.status, total: k(b.total || 0), paid: k(b.paid || 0), balance: k(b.balance || 0) });
    (b.payments || []).forEach((p) => { if (p.kind !== 'REFUND') row.methods.add(p.method); });
    if (b.status !== 'VOID') { row.total += b.total || 0; row.paid += b.paid || 0; row.balance += b.balance || 0; }
    by.set(key, row);
  });
  return docs.map((d) => {
    const j = d.toJSON(); const row = by.get(String(d._id));
    j.branchName = bn.get(String(d.branchId)) || '';
    j.payment = row ? { bills: row.bills, methods: [...row.methods], billTotal: k(row.total), paid: k(row.paid), balance: k(row.balance) } : { bills: [], methods: [], billTotal: 0, paid: 0, balance: 0 };
    j.itemCount = (j.items || []).filter((i) => i.status !== 'CANCELLED').reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    return j;
  });
}

async function orderSummary(f) {
  const [a] = await RestaurantOrder.aggregate([{ $match: f }, { $facet: {
    tot: [{ $group: { _id: null, orders: { $sum: 1 }, sales: { $sum: NOT_CANCELLED }, cancelled: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, 1, 0] } }, guests: { $sum: '$guestCount' }, fees: { $sum: { $ifNull: ['$delivery.fee', 0] } } } }],
    byStatus: [{ $group: { _id: '$status', orders: { $sum: 1 } } }],
    byType: [{ $group: { _id: '$orderType', orders: { $sum: 1 }, sales: { $sum: NOT_CANCELLED } } }, { $sort: { sales: -1 } }],
    bySource: [{ $group: { _id: '$source', orders: { $sum: 1 }, sales: { $sum: NOT_CANCELLED } } }, { $sort: { sales: -1 } }],
  } }]);
  const t = (a && a.tot[0]) || {}; const live = (t.orders || 0) - (t.cancelled || 0);
  return {
    orders: t.orders || 0, cancelled: t.cancelled || 0, sales: k(t.sales || 0), average: live > 0 ? k(Math.round((t.sales || 0) / live)) : 0, guests: t.guests || 0, deliveryFees: k(t.fees || 0),
    byStatus: ((a && a.byStatus) || []).map((x) => ({ status: x._id, orders: x.orders })),
    byType: ((a && a.byType) || []).map((x) => ({ orderType: x._id, orders: x.orders, sales: k(x.sales) })),
    bySource: ((a && a.bySource) || []).map((x) => ({ source: x._id, orders: x.orders, sales: k(x.sales) })),
  };
}

async function facets(businessId, user, q) {
  const base = { businessId: C.oid(businessId), ...C.branchFilter(C.branchScope(user, q.branchId)) };
  if (q.from || q.to) { base.createdAt = {}; if (q.from) base.createdAt.$gte = new Date(q.from); if (q.to) base.createdAt.$lte = new Date(q.to); }
  const [w, r] = await Promise.all([
    RestaurantOrder.aggregate([{ $match: { ...base, waiterId: { $ne: null } } }, { $group: { _id: '$waiterId', name: { $last: '$waiterName' }, orders: { $sum: 1 } } }, { $sort: { name: 1 } }, { $limit: 200 }]),
    RestaurantOrder.aggregate([{ $match: { ...base, 'delivery.riderId': { $ne: null } } }, { $group: { _id: '$delivery.riderId', name: { $last: '$delivery.riderName' }, orders: { $sum: 1 } } }, { $sort: { name: 1 } }, { $limit: 200 }]),
  ]);
  return { waiters: w.map((x) => ({ id: String(x._id), name: x.name || 'Staff', orders: x.orders })), riders: r.map((x) => ({ id: String(x._id), name: x.name || 'Rider', orders: x.orders })) };
}

async function orders(businessId, user, q, mode = 'orders') {
  const f = await buildFilter(businessId, user, q, mode);
  const page = q.page || 1, limit = q.limit || 25;
  const [docs, total, summary, fac] = await Promise.all([
    RestaurantOrder.find(f).select(SELECT).sort(SORTS[q.sort] || SORTS.newest).skip((page - 1) * limit).limit(limit),
    RestaurantOrder.countDocuments(f),
    page === 1 || q.facets === '1' ? orderSummary(f) : null,
    q.facets === '1' ? facets(businessId, user, q) : null,
  ]);
  const out = C.paged(await shapeOrders(C.oid(businessId), docs), total, { page, limit });
  if (summary) out.summary = summary;
  if (fac) out.facets = fac;
  return out;
}

/** Past deliveries and pickups. Default outcome DONE = delivered or handed over; ALL also shows failed, cancelled and still-open ones. */
async function deliveries(businessId, user, q) {
  const qq = { ...q, outcome: q.outcome || 'DONE' };
  if (!qq.orderType && qq.scope === 'all') qq.orderType = 'DELIVERY,PICKUP,TAKEAWAY';
  if (qq.scope === 'all' && qq.outcome === 'DONE' && !qq.dateField) qq.dateField = 'createdAt';
  const f = await buildFilter(businessId, user, qq, 'delivery');
  const page = qq.page || 1, limit = qq.limit || 25;
  const [docs, total, perf, fac] = await Promise.all([
    RestaurantOrder.find(f).select(SELECT).sort(SORTS[qq.sort] || SORTS.newest).skip((page - 1) * limit).limit(limit),
    RestaurantOrder.countDocuments(f),
    page === 1 ? RestaurantOrder.aggregate([{ $match: f }, { $facet: {
      tot: [{ $group: { _id: null, orders: { $sum: 1 }, sales: { $sum: NOT_CANCELLED }, fees: { $sum: { $ifNull: ['$delivery.fee', 0] } },
        delivered: { $sum: { $cond: [{ $eq: ['$delivery.status', 'DELIVERED'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$delivery.status', 'FAILED'] }, 1, 0] } }, collected: { $sum: { $cond: [{ $eq: ['$pickup.status', 'COLLECTED'] }, 1, 0] } },
        avgMs: { $avg: { $cond: [{ $and: [{ $eq: ['$delivery.status', 'DELIVERED'] }, { $gt: ['$delivery.deliveredAt', null] }], }, { $subtract: ['$delivery.deliveredAt', '$createdAt'] }, null] } } } }],
      byRider: [{ $match: { 'delivery.riderId': { $ne: null } } }, { $group: { _id: '$delivery.riderId', name: { $last: '$delivery.riderName' }, orders: { $sum: 1 }, delivered: { $sum: { $cond: [{ $eq: ['$delivery.status', 'DELIVERED'] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ['$delivery.status', 'FAILED'] }, 1, 0] } }, sales: { $sum: NOT_CANCELLED } } }, { $sort: { delivered: -1 } }, { $limit: 50 }],
    } }]) : null,
    q.facets === '1' ? facets(businessId, user, qq) : null,
  ]);
  const out = C.paged(await shapeOrders(C.oid(businessId), docs), total, { page, limit });
  if (perf) {
    const t = (perf[0] && perf[0].tot[0]) || {};
    out.summary = { orders: t.orders || 0, delivered: t.delivered || 0, collected: t.collected || 0, failed: t.failed || 0, sales: k(t.sales || 0), deliveryFees: k(t.fees || 0), avgDeliveryMinutes: t.avgMs ? r1(t.avgMs / 60000) : null,
      byRider: ((perf[0] && perf[0].byRider) || []).map((x) => ({ id: String(x._id), name: x.name || 'Rider', orders: x.orders, delivered: x.delivered, failed: x.failed, sales: k(x.sales) })) };
  }
  if (fac) out.facets = fac;
  return out;
}

/** Past guest QR orders ("requests") and "call waiter / bill / cleaning" calls. */
async function guest(businessId, user, q) {
  C.requireCan(user, 'restaurant.guest.view', 'Needs permission');
  const bid = C.oid(businessId); const page = q.page || 1, limit = q.limit || 25;
  const f = { businessId: bid, ...C.branchFilter(C.branchScope(user, q.branchId)) };
  const sts = csv(q.status); if (sts.length) f.status = { $in: sts };
  const kinds = csv(q.kind); if (kinds.length) f.kind = { $in: kinds };
  if (q.from || q.to) { f.createdAt = {}; if (q.from) f.createdAt.$gte = new Date(q.from); if (q.to) f.createdAt.$lte = new Date(q.to); }
  const sort = { createdAt: q.sort === 'oldest' ? 1 : -1 };

  if (q.type === 'calls') {
    const and = [];
    for (const t of terms(q.search)) { const r = rx(t); and.push({ $or: [{ tableName: r }, { roomNumber: r }, { note: r }, { guestName: r }, { acknowledgedByName: r }, { kind: r }] }); }
    if (!C.can(user, 'restaurant.orders.view_all') && !C.can(user, 'accommodation.housekeeping.manage')) and.push({ $or: [{ waiterId: { $exists: false } }, { waiterId: null }, { waiterId: C.oid(user._id) }] });
    if (and.length) f.$and = and;
    const [rows, total, agg] = await Promise.all([
      ServiceCall.find(f).sort(sort).skip((page - 1) * limit).limit(limit),
      ServiceCall.countDocuments(f),
      page === 1 ? ServiceCall.aggregate([{ $match: f }, { $facet: {
        byStatus: [{ $group: { _id: '$status', n: { $sum: 1 } } }], byKind: [{ $group: { _id: '$kind', n: { $sum: 1 } } }, { $sort: { n: -1 } }],
        speed: [{ $group: { _id: null, ack: { $avg: { $cond: [{ $gt: ['$acknowledgedAt', null] }, { $subtract: ['$acknowledgedAt', '$createdAt'] }, null] } }, res: { $avg: { $cond: [{ $gt: ['$resolvedAt', null] }, { $subtract: ['$resolvedAt', '$createdAt'] }, null] } } } }],
      } }]) : null,
    ]);
    const out = C.paged(rows.map((x) => x.toJSON()), total, { page, limit });
    if (agg) { const a = agg[0]; const sp = a.speed[0] || {}; out.summary = { total, byStatus: a.byStatus.map((x) => ({ status: x._id, count: x.n })), byKind: a.byKind.map((x) => ({ kind: x._id, count: x.n })), avgAckMinutes: sp.ack ? r1(sp.ack / 60000) : null, avgResolveMinutes: sp.res ? r1(sp.res / 60000) : null }; }
    return out;
  }

  // requests: search also reaches the order number the request became
  const and = [];
  for (const t of terms(q.search)) {
    const r = rx(t); const ords = await RestaurantOrder.distinct('_id', { businessId: bid, orderNumber: r });
    and.push({ $or: [{ tableName: r }, { roomNumber: r }, { 'guest.name': r }, { 'guest.phone': r }, { notes: r }, { 'items.name': r }, { 'decision.byName': r }, { 'decision.reason': r }, ...(ords.length ? [{ orderId: { $in: ords } }] : [])] });
  }
  if (and.length) f.$and = and;
  const [rows, total, agg] = await Promise.all([
    GuestRequest.find(f).select('-ipHash -clientRef').sort(sort).skip((page - 1) * limit).limit(limit),
    GuestRequest.countDocuments(f),
    page === 1 ? GuestRequest.aggregate([{ $match: f }, { $facet: {
      byStatus: [{ $group: { _id: '$status', n: { $sum: 1 }, value: { $sum: '$estimatedTotal' } } }],
      byKind: [{ $group: { _id: '$kind', n: { $sum: 1 } } }],
    } }]) : null,
  ]);
  const orderIds = rows.map((x) => x.orderId).filter(Boolean);
  const ords = orderIds.length ? await RestaurantOrder.find({ businessId: bid, _id: { $in: orderIds } }).select('orderNumber status billStatus totals.total') : [];
  const om = new Map(ords.map((o) => [String(o._id), o.toJSON()]));
  const out = C.paged(rows.map((x) => { const j = x.toJSON(); j.order = x.orderId ? om.get(String(x.orderId)) || null : null; return j; }), total, { page, limit });
  if (agg) {
    const a = agg[0]; const ok = a.byStatus.filter((x) => ['ACCEPTED', 'AUTO_ACCEPTED'].includes(x._id));
    out.summary = { total, byStatus: a.byStatus.map((x) => ({ status: x._id, count: x.n })), byKind: a.byKind.map((x) => ({ kind: x._id, count: x.n })), acceptedCount: ok.reduce((s, x) => s + x.n, 0), acceptedValue: k(ok.reduce((s, x) => s + (x.value || 0), 0)) };
  }
  return out;
}

module.exports = { orders, deliveries, guest };
