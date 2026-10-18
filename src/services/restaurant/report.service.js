/** Restaurant reports. Revenue comes from PAID bills (the same figures that became Sales); cost figures only when the caller may see profit. */
const RestaurantBill = require('../../models/RestaurantBill');
const RestaurantOrder = require('../../models/RestaurantOrder');
const Payment = require('../../models/Payment');
const IngredientMovement = require('../../models/IngredientMovement');
const IngredientCount = require('../../models/IngredientCount');
const IngredientStock = require('../../models/IngredientStock');
const Ingredient = require('../../models/Ingredient');
const TipRecord = require('../../models/TipRecord');
const WasteRecord = require('../../models/WasteRecord');
const { fromCents: k } = require('../../utils/money');
const C = require('./common');

const range = (from, to, days = 30) => { const end = to ? new Date(to) : new Date(); return { start: from ? new Date(from) : new Date(end.getTime() - days * 86400000), end }; };
const canProfit = (user) => C.can(user, 'reports.profit');
const base = (businessId, user, branchId, start, end, field = 'settledAt') => ({ businessId: C.oid(businessId), ...C.branchFilter(C.branchScope(user, branchId)), [field]: { $gte: start, $lte: end } });
const r1 = (n) => Math.round(n * 10) / 10;

async function summary(businessId, user, { branchId, from, to }) {
  const { start, end } = range(from, to); const bm = { ...base(businessId, user, branchId, start, end), status: 'PAID' };
  const om = { ...base(businessId, user, branchId, start, end, 'closedAt'), status: 'CLOSED' };
  const [b, o, voids, pay, refunds, tips, credit, byType] = await Promise.all([
    RestaurantBill.aggregate([{ $match: bm }, { $group: { _id: null, bills: { $sum: 1 }, revenue: { $sum: { $subtract: ['$total', '$waived'] } }, tax: { $sum: '$tax' }, serviceCharge: { $sum: '$serviceCharge' }, discount: { $sum: '$discount' }, comps: { $sum: '$compValue' }, cost: { $sum: '$cost' }, waived: { $sum: '$waived' } } }]),
    RestaurantOrder.aggregate([{ $match: om }, { $group: { _id: null, orders: { $sum: 1 }, covers: { $sum: '$guestCount' }, turnover: { $avg: { $cond: [{ $eq: ['$orderType', 'DINE_IN'] }, { $divide: [{ $subtract: ['$closedAt', '$createdAt'] }, 60000] }, null] } } } }]),
    RestaurantOrder.aggregate([{ $match: base(businessId, user, branchId, start, end, 'updatedAt') }, { $unwind: '$items' }, { $match: { 'items.status': 'CANCELLED', 'items.cancelledAt': { $gte: start, $lte: end }, 'items.parentItemId': null } }, { $group: { _id: null, count: { $sum: 1 }, value: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } }, afterPrep: { $sum: { $cond: ['$items.cancelledAfterPrep', 1, 0] } } } }]),
    Payment.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), restaurantBillId: { $ne: null }, status: 'SUCCESS', 'metadata.kind': { $ne: 'TIP' } } }, { $group: { _id: '$method', total: { $sum: '$amount' } } }]),
    Payment.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), restaurantBillId: { $ne: null }, status: 'REFUNDED' } }, { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    TipRecord.aggregate([{ $match: base(businessId, user, branchId, start, end, 'createdAt') }, { $group: { _id: null, total: { $sum: '$amount' } } }]),
    RestaurantBill.aggregate([{ $match: { ...bm, creditAmount: { $gt: 0 } } }, { $group: { _id: null, total: { $sum: '$creditAmount' } } }]),
    RestaurantBill.aggregate([{ $match: bm }, { $group: { _id: '$orderType', bills: { $sum: 1 }, revenue: { $sum: { $subtract: ['$total', '$waived'] } } } }]),
  ]);
  const t = b[0] || {}; const ord = o[0] || {}; const v = voids[0] || {};
  const out = {
    from: start, to: end, bills: t.bills || 0, orders: ord.orders || 0, covers: ord.covers || 0, revenue: k(t.revenue || 0), tax: k(t.tax || 0), serviceCharge: k(t.serviceCharge || 0), discounts: k(t.discount || 0), complimentaryValue: k(t.comps || 0), writtenOff: k(t.waived || 0),
    averageOrderValue: ord.orders ? k(Math.round((t.revenue || 0) / ord.orders)) : 0, averageSpendPerCover: ord.covers ? k(Math.round((t.revenue || 0) / ord.covers)) : 0, averageTableMinutes: ord.turnover ? r1(ord.turnover) : null,
    voidedItems: v.count || 0, voidedValue: k(v.value || 0), voidedAfterPreparation: v.afterPrep || 0, refunds: { count: refunds[0]?.count || 0, total: k(refunds[0]?.total || 0) }, tips: k(tips[0]?.total || 0), onCredit: k(credit[0]?.total || 0),
    paymentsByMethod: pay.map((p) => ({ method: p._id, total: k(p.total) })), byOrderType: byType.map((x) => ({ orderType: x._id, bills: x.bills, revenue: k(x.revenue) })),
  };
  if (canProfit(user)) { out.foodCost = k(t.cost || 0); out.grossProfit = k((t.revenue || 0) - (t.tax || 0) - (t.cost || 0)); out.foodCostPercent = t.revenue ? r1(((t.cost || 0) / Math.max(1, (t.revenue - t.tax))) * 100) : null; }
  return out;
}

async function sales(businessId, user, { branchId, from, to, groupBy = 'day' }, tz = 'Africa/Nairobi') {
  const { start, end } = range(from, to); const m = { ...base(businessId, user, branchId, start, end), status: 'PAID' };
  const profit = canProfit(user);
  const lineGroup = (id, nameField) => [{ $unwind: '$lines' }, { $match: { 'lines.isComp': false } }, { $group: { _id: id, name: { $first: nameField }, quantity: { $sum: '$lines.quantity' }, revenue: { $sum: '$lines.total' }, cost: { $sum: '$lines.cost' }, bills: { $addToSet: '$_id' } } }, { $sort: { revenue: -1 } }, { $limit: 200 }];
  const billGroup = (id) => [{ $group: { _id: id, bills: { $sum: 1 }, revenue: { $sum: { $subtract: ['$total', '$waived'] } }, covers: { $sum: '$guestCount' }, tips: { $sum: 0 } } }, { $sort: { _id: 1 } }];
  const tzd = { date: '$settledAt', timezone: tz };
  const P = {
    item: lineGroup('$lines.name', '$lines.name'), category: lineGroup('$lines.categoryName', '$lines.categoryName'),
    waiter: billGroup({ id: '$waiterId', name: '$waiterName' }), orderType: billGroup('$orderType'), table: billGroup('$tableName'), branch: billGroup('$branchId'),
    day: billGroup({ $dateToString: { format: '%Y-%m-%d', date: '$settledAt', timezone: tz } }), hour: billGroup({ $hour: tzd }), dow: billGroup({ $dayOfWeek: tzd }),
  };
  if (!P[groupBy]) return [];
  const rows = await RestaurantBill.aggregate([{ $match: m }, ...P[groupBy]]);
  return rows.map((r) => ({ key: r._id, ...(r.name !== undefined ? { name: r.name } : {}), ...(r.quantity !== undefined ? { quantity: r.quantity } : {}), bills: Array.isArray(r.bills) ? r.bills.length : r.bills, ...(r.covers !== undefined ? { covers: r.covers } : {}), revenue: k(r.revenue), ...(profit && r.cost !== undefined ? { cost: k(r.cost), margin: k(r.revenue - r.cost) } : {}) }));
}

/** Per dish: sold, revenue (ex tax), recipe cost, food-cost %, contribution margin; plus ingredient usage. Needs profit visibility. */
async function foodCost(businessId, user, { branchId, from, to }) {
  if (!canProfit(user)) return { restricted: true };
  const { start, end } = range(from, to);
  const [dishes, usage] = await Promise.all([
    RestaurantBill.aggregate([{ $match: { ...base(businessId, user, branchId, start, end), status: 'PAID' } }, { $unwind: '$lines' }, { $match: { 'lines.isComp': false } }, { $group: { _id: '$lines.menuItemId', name: { $first: '$lines.name' }, sold: { $sum: '$lines.quantity' }, revenue: { $sum: { $subtract: ['$lines.total', '$lines.taxAmount'] } }, cost: { $sum: '$lines.cost' } } }, { $sort: { revenue: -1 } }]),
    IngredientMovement.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), type: { $in: ['CONSUMPTION', 'CONSUMPTION_REVERSAL', 'WASTE', 'SPOILAGE', 'EXPIRED', 'STAFF_MEAL', 'COMPLIMENTARY'] } } }, { $group: { _id: { id: '$ingredientId', type: '$type' }, qty: { $sum: '$quantity' }, value: { $sum: { $multiply: [{ $cond: [{ $lt: ['$quantity', 0] }, 1, -1] }, '$value'] } } } }, { $lookup: { from: 'ingredients', localField: '_id.id', foreignField: '_id', as: 'i' } }, { $project: { _id: 0, ingredientId: '$_id.id', type: '$_id.type', name: { $arrayElemAt: ['$i.name', 0] }, unit: { $arrayElemAt: ['$i.baseUnit', 0] }, quantity: { $abs: '$qty' }, value: 1 } }]),
  ]);
  return {
    from: start, to: end,
    dishes: dishes.map((d) => ({ menuItemId: d._id, name: d.name, sold: d.sold, revenue: k(d.revenue), cost: k(d.cost), foodCostPercent: d.revenue ? r1((d.cost / d.revenue) * 100) : null, contribution: k(d.revenue - d.cost), contributionPerPortion: d.sold ? k(Math.round((d.revenue - d.cost) / d.sold)) : 0 })),
    ingredientUsage: usage.map((u) => ({ ...u, value: k(Math.abs(u.value)) })),
  };
}

async function staff(businessId, user, { branchId, from, to }) {
  C.requireCan(user, 'restaurant.reports.staff', 'Staff performance is for managers');
  const { start, end } = range(from, to);
  const [bills, voids, tips] = await Promise.all([
    RestaurantBill.aggregate([{ $match: { ...base(businessId, user, branchId, start, end), status: 'PAID' } }, { $group: { _id: { id: '$waiterId', name: '$waiterName' }, bills: { $sum: 1 }, revenue: { $sum: { $subtract: ['$total', '$waived'] } }, covers: { $sum: '$guestCount' }, discounts: { $sum: '$discount' }, comps: { $sum: '$compValue' } } }, { $sort: { revenue: -1 } }]),
    RestaurantOrder.aggregate([{ $match: base(businessId, user, branchId, start, end, 'updatedAt') }, { $unwind: '$items' }, { $match: { 'items.status': 'CANCELLED', 'items.cancelledAt': { $gte: start, $lte: end }, 'items.parentItemId': null } }, { $group: { _id: '$items.cancelledBy', voids: { $sum: 1 }, value: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } } } }]),
    TipRecord.aggregate([{ $match: base(businessId, user, branchId, start, end, 'createdAt') }, { $group: { _id: '$waiterId', tips: { $sum: '$amount' } } }]),
  ]);
  const v = new Map(voids.map((x) => [String(x._id), x])); const t = new Map(tips.map((x) => [String(x._id), x.tips]));
  return bills.map((b) => ({ waiterId: b._id.id, name: b._id.name, bills: b.bills, revenue: k(b.revenue), covers: b.covers, averageBill: b.bills ? k(Math.round(b.revenue / b.bills)) : 0, discounts: k(b.discounts), complimentary: k(b.comps), voids: v.get(String(b._id.id))?.voids || 0, voidValue: k(v.get(String(b._id.id))?.value || 0), tips: k(t.get(String(b._id.id)) || 0) }));
}

async function waste(businessId, user, { branchId, from, to }) {
  const { start, end } = range(from, to);
  const rows = await WasteRecord.aggregate([{ $match: base(businessId, user, branchId, start, end, 'createdAt') }, { $group: { _id: { kind: '$kind', name: '$name' }, count: { $sum: 1 }, quantity: { $sum: '$quantity' }, cost: { $sum: '$cost' } } }, { $sort: { cost: -1 } }]);
  return { from: start, to: end, total: k(rows.reduce((s, r) => s + r.cost, 0)), rows: rows.map((r) => ({ kind: r._id.kind, name: r._id.name, count: r.count, quantity: r.quantity, cost: k(r.cost) })) };
}

/** Stock variance: approved count variances (value at current cost) and ingredients currently below zero (usage the recipes did not explain). */
async function stockVariance(businessId, user, { branchId, from, to }) {
  const { start, end } = range(from, to, 90);
  const scope = C.branchScope(user, branchId);
  const counts = await IngredientMovement.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), type: 'COUNT_ADJUSTMENT' } }, { $group: { _id: '$ingredientId', variance: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$unitCost'] } } } }, { $lookup: { from: 'ingredients', localField: '_id', foreignField: '_id', as: 'i' } }, { $project: { _id: 0, ingredientId: '$_id', name: { $arrayElemAt: ['$i.name', 0] }, unit: { $arrayElemAt: ['$i.baseUnit', 0] }, variance: 1, value: 1 } }, { $sort: { value: 1 } }]);
  const neg = await IngredientStock.find({ businessId, ...C.branchFilter(scope), quantity: { $lt: 0 } }).populate('ingredientId', 'name baseUnit');
  return { from: start, to: end, countVariances: counts.map((c) => ({ ...c, value: k(Math.round(c.value)) })), totalVarianceValue: k(Math.round(counts.reduce((s, c) => s + c.value, 0))), negativeStock: neg.map((s) => ({ ingredient: s.ingredientId?.name, location: s.location, quantity: s.quantity, unit: s.ingredientId?.baseUnit })) };
}

/** Cash / M-Pesa / card reconciliation: money taken per method (and per shift) against what bills say was paid. */
async function reconciliation(businessId, user, { branchId, from, to }) {
  const { start, end } = range(from, to, 1);
  const [byMethod, byShift, billPaid] = await Promise.all([
    Payment.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), restaurantBillId: { $ne: null }, 'metadata.kind': { $ne: 'TIP' }, status: { $in: ['SUCCESS', 'REFUNDED'] } } }, { $group: { _id: { method: '$method', status: '$status' }, total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), restaurantBillId: { $ne: null }, status: 'SUCCESS' } }, { $group: { _id: { shift: '$shiftId', method: '$method' }, total: { $sum: '$amount' } } }]),
    RestaurantBill.aggregate([{ $match: { ...base(businessId, user, branchId, start, end), status: 'PAID' } }, { $group: { _id: null, total: { $sum: { $subtract: ['$total', '$waived'] } }, credit: { $sum: '$creditAmount' } } }]),
  ]);
  const received = byMethod.filter((x) => x._id.status === 'SUCCESS').reduce((s, x) => s + x.total, 0);
  const refunded = byMethod.filter((x) => x._id.status === 'REFUNDED').reduce((s, x) => s + x.total, 0);
  return { from: start, to: end, byMethod: byMethod.map((x) => ({ method: x._id.method, kind: x._id.status === 'SUCCESS' ? 'received' : 'refunded', count: x.count, total: k(x.total) })), byShift: byShift.map((x) => ({ shiftId: x._id.shift, method: x._id.method, total: k(x.total) })), billsSettled: k(billPaid[0]?.total || 0), onCredit: k(billPaid[0]?.credit || 0), received: k(received), refunded: k(refunded) };
}

async function delivery(businessId, user, { branchId, from, to }) {
  const { start, end } = range(from, to);
  const rows = await RestaurantOrder.aggregate([{ $match: { ...base(businessId, user, branchId, start, end, 'createdAt'), orderType: 'DELIVERY' } }, { $group: { _id: { rider: '$delivery.riderName', status: '$delivery.status' }, orders: { $sum: 1 }, fees: { $sum: '$delivery.fee' }, avgMinutes: { $avg: { $cond: [{ $ne: ['$delivery.deliveredAt', null] }, { $divide: [{ $subtract: ['$delivery.deliveredAt', '$createdAt'] }, 60000] }, null] } } } }]);
  return rows.map((r) => ({ rider: r._id.rider, status: r._id.status, orders: r.orders, deliveryFees: k(r.fees), avgMinutes: r.avgMinutes ? r1(r.avgMinutes) : null }));
}

async function dashboard(businessId, user, { branchId }) {
  const scope = C.branchScope(user, branchId); const f = { businessId: C.oid(businessId), ...C.branchFilter(scope) };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const KT = require('../../models/KitchenTicket'); const T = require('../../models/RestaurantTable');
  const [open, tables, queue, sum] = await Promise.all([
    RestaurantOrder.countDocuments({ ...f, status: 'OPEN' }), T.aggregate([{ $match: { ...f, active: true, combinedInto: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    KT.countDocuments({ ...f, status: { $in: ['NEW', 'ACCEPTED', 'PREPARING'] } }), summary(businessId, user, { branchId, from: today, to: new Date() }),
  ]);
  return { openOrders: open, tables: Object.fromEntries(tables.map((t) => [t._id, t.n])), kitchenQueue: queue, today: { revenue: sum.revenue, orders: sum.orders, averageOrderValue: sum.averageOrderValue, ...(sum.foodCostPercent !== undefined ? { foodCostPercent: sum.foodCostPercent } : {}) } };
}

module.exports = { summary, sales, foodCost, staff, waste, stockVariance, reconciliation, delivery, dashboard };
