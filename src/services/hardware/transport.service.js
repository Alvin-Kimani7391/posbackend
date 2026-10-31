/** Transport: fleet, price rules, job pricing, assignment, trip costs, payments, profit and reports. Money = integer cents. */
const mongoose = require('mongoose');
const FleetVehicle = require('../../models/FleetVehicle');
const TransportRate = require('../../models/TransportRate');
const TransportCost = require('../../models/TransportCost');
const LandedCost = require('../../models/LandedCost');
const DeliveryOrder = require('../../models/DeliveryOrder');
const HardwareProfile = require('../../models/HardwareProfile');
const HardwareSettings = require('../../models/HardwareSettings');
const Expense = require('../../models/Expense');
const User = require('../../models/User');
const AuditLog = require('../../models/AuditLog');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { fromCents } = require('../../utils/money');
const { hasPermission } = require('../../utils/permissionCheck');
const { computeCharge, paymentState, jobProfit, unallocated } = require('./transport-pricing');
const { JOB_COST_TYPES, VEHICLE_COST_TYPES } = require('../../constants/hardware');
const ApiError = require('../../utils/ApiError');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const DAY = 86400000;
const money = (c) => fromCents(Math.round(c || 0));
const clean = (o) => { Object.keys(o).forEach((k) => o[k] === undefined && delete o[k]); return o; };
const dup = (e, msg, code) => { if (e.code === 11000) throw ApiError.conflict(msg, code); if (e.name === 'ValidationError') throw ApiError.badRequest(e.message.replace(/^.*?: /, ''), 'INVALID'); throw e; };
const log = (businessId, user, action, entityType, entityId, newValue, branchId) => AuditLog.create({ businessId, branchId, userId: user._id, action, entityType, entityId, newValue });
const settingsOf = async (businessId) => (await HardwareSettings.findOne({ businessId }).lean()) || {};

// ---------- fleet ----------
async function listVehicles(businessId, { status, ownership } = {}) { const q = { businessId }; if (status) q.status = status; if (ownership) q.ownership = ownership; return FleetVehicle.find(q).populate('defaultDriverId', 'name').sort({ plate: 1 }).limit(300); }
async function saveVehicle(businessId, user, id, input) {
  if (input.defaultDriverId && !(await User.exists({ _id: input.defaultDriverId, businessId, status: 'active' }))) throw ApiError.badRequest('Driver not found', 'DRIVER_NOT_FOUND');
  const doc = id ? await FleetVehicle.findOne({ _id: id, businessId }) : new FleetVehicle({ businessId, createdBy: user._id });
  if (!doc) throw ApiError.notFound('Vehicle not found');
  if (input.odometerKm !== undefined && id && input.odometerKm < doc.odometerKm) throw ApiError.badRequest('The odometer cannot go backwards', 'ODOMETER_BACKWARDS');
  Object.assign(doc, clean({ ...input }));
  try { await doc.save(); } catch (e) { dup(e, 'A vehicle with this registration already exists', 'DUPLICATE_PLATE'); }
  await log(businessId, user, id ? 'hardware.fleet.update' : 'hardware.fleet.create', 'FleetVehicle', doc._id, { plate: doc.plate });
  return doc;
}
/** Insurance / inspection / licence / service dates that are due soon or already past. */
async function vehicleAlerts(businessId, { days = 30 } = {}) {
  const limit = new Date(Date.now() + days * DAY); const out = [];
  const vs = await FleetVehicle.find({ businessId, status: { $ne: 'INACTIVE' } }).lean();
  for (const v of vs) for (const [k, label] of [['insuranceExpiry', 'Insurance'], ['inspectionExpiry', 'Inspection'], ['licenceExpiry', 'Licence'], ['nextServiceDate', 'Service']]) {
    if (v[k] && v[k] <= limit) out.push({ vehicleId: v._id, plate: v.plate, item: label, date: v[k], overdue: v[k] < new Date(), daysLeft: Math.ceil((v[k] - Date.now()) / DAY) });
    if (k === 'nextServiceDate' && v.nextServiceKm && v.odometerKm >= v.nextServiceKm - 500) out.push({ vehicleId: v._id, plate: v.plate, item: 'Service (mileage)', overdue: v.odometerKm >= v.nextServiceKm, kmLeft: v.nextServiceKm - v.odometerKm });
  }
  return out.sort((a, b) => (b.overdue - a.overdue) || ((a.daysLeft ?? 0) - (b.daysLeft ?? 0)));
}

// ---------- rates / pricing ----------
async function listRates(businessId, { component, active } = {}) { const q = { businessId }; if (component) q.component = component; if (active !== undefined) q.active = active; return TransportRate.find(q).sort({ component: 1, zone: 1 }); }
async function saveRate(businessId, user, id, input) {
  const doc = id ? await TransportRate.findOne({ _id: id, businessId }) : new TransportRate({ businessId });
  if (!doc) throw ApiError.notFound('Rate not found');
  Object.assign(doc, clean({ ...input }));
  try { await doc.save(); } catch (e) { dup(e, 'Rate already exists', 'DUPLICATE'); }
  await log(businessId, user, id ? 'hardware.rate.update' : 'hardware.rate.create', 'TransportRate', doc._id, input);
  return doc;
}
async function removeRate(businessId, user, id) { const d = await TransportRate.findOneAndDelete({ _id: id, businessId }); if (!d) throw ApiError.notFound('Rate not found'); await log(businessId, user, 'hardware.rate.delete', 'TransportRate', id); return { removed: true }; }
/** What would this job cost the customer? Same function used when a job is created. */
async function priceFor(businessId, input) {
  const rates = await TransportRate.find({ businessId, active: true }).lean();
  const s = await settingsOf(businessId);
  const r = computeCharge({ rates, ctx: input.ctx || {}, settings: s, rateIds: input.rateIds, negotiatedTotal: input.negotiatedTotal });
  return { ...r, lines: r.lines.map((l) => ({ ...l, unitValue: money(l.unitValue), amount: money(l.amount) })), subtotal: money(r.subtotal), total: money(r.total), chargeToCustomer: money(r.chargeToCustomer), _cents: { subtotal: r.subtotal, total: r.total, chargeToCustomer: r.chargeToCustomer, lines: r.lines } };
}

// ---------- assignment ----------
async function loadJob(businessId, id) { const d = await DeliveryOrder.findOne({ _id: id, businessId }); if (!d) throw ApiError.notFound('Job not found'); return d; }
async function jobWeight(businessId, d) {
  if (d.loadWeightKg) return d.loadWeightKg;
  const ids = d.items.map((i) => i.productId).filter(Boolean); if (!ids.length) return 0;
  const profs = await HardwareProfile.find({ businessId, productId: { $in: ids } }).select('productId weightKg').lean(); const W = new Map(profs.map((p) => [String(p.productId), p.weightKg || 0]));
  return d.items.reduce((s, i) => s + (W.get(String(i.productId)) || 0) * i.quantity, 0);
}
async function assign(businessId, user, id, { fleetVehicleId, driverId, loaders, subcontractor, allowShared, allowOverload }) {
  const d = await loadJob(businessId, id);
  if (['DELIVERED', 'CANCELLED', 'IN_TRANSIT'].includes(d.status)) throw ApiError.conflict('This job can no longer be re-assigned', 'CLOSED');
  const manage = hasPermission(user, 'hardware.transport.manage');
  if (fleetVehicleId) {
    const v = await FleetVehicle.findOne({ _id: fleetVehicleId, businessId }); if (!v) throw ApiError.badRequest('Vehicle not found', 'VEHICLE_NOT_FOUND');
    if (v.status !== 'AVAILABLE') throw ApiError.conflict(`${v.plate} is ${v.status.toLowerCase()}`, 'VEHICLE_UNAVAILABLE');
    const day0 = new Date(d.scheduledFor); day0.setHours(0, 0, 0, 0); const day1 = new Date(day0.getTime() + DAY);
    const clash = await DeliveryOrder.findOne({ businessId, _id: { $ne: d._id }, fleetVehicleId: v._id, status: { $in: ['PENDING', 'LOADED', 'IN_TRANSIT'] }, scheduledFor: { $gte: day0, $lt: day1 } }).select('number');
    if (clash && !(allowShared && manage)) throw ApiError.conflict(`${v.plate} already has ${clash.number} that day`, 'VEHICLE_BUSY');
    const w = await jobWeight(businessId, d);
    if (v.capacityKg && w > v.capacityKg && !(allowOverload && manage)) throw ApiError.conflict(`Load is about ${Math.round(w)} kg but ${v.plate} carries ${v.capacityKg} kg`, 'OVERLOAD');
    d.fleetVehicleId = v._id; d.vehicle = v.plate;
    if (!driverId && !d.driverId && v.defaultDriverId) d.driverId = v.defaultDriverId;
  }
  if (driverId) { if (!(await User.exists({ _id: driverId, businessId, status: 'active' }))) throw ApiError.badRequest('Driver not found', 'DRIVER_NOT_FOUND'); d.driverId = driverId; }
  if (loaders) d.loaders = loaders;
  if (subcontractor) d.subcontractor = subcontractor;
  d.events.push({ status: d.status, at: new Date(), by: user._id, note: 'Assigned' }); await d.save();
  await log(businessId, user, 'hardware.transport.assign', 'DeliveryOrder', d._id, { fleetVehicleId, driverId }, d.branchId);
  return d;
}

// ---------- costs ----------
async function recomputeJobCost(deliveryId) {
  const [r] = await TransportCost.aggregate([{ $match: { deliveryId: oid(deliveryId), voided: false } }, { $group: { _id: null, t: { $sum: '$amount' } } }]);
  const has = await TransportCost.exists({ deliveryId, voided: false });
  if (has) await DeliveryOrder.updateOne({ _id: deliveryId }, { $set: { cost: r ? r.t : 0 } }); // cost lines are the single source of truth once any exist
  return r ? r.t : 0;
}
async function allocatedOf(businessId, expenseId, exceptId) {
  const [a, b] = await Promise.all([TransportCost.find({ businessId, expenseId, voided: false, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('amount').lean(), LandedCost.find({ businessId, expenseId, voided: false }).select('amount').lean()]);
  return [...a, ...b].map((x) => x.amount);
}
async function addCost(businessId, user, input) {
  let d = null; let vehicleId = input.fleetVehicleId; let branchId = input.branchId;
  if (input.deliveryId) {
    d = await loadJob(businessId, input.deliveryId); branchId = d.branchId;
    if (!hasPermission(user, 'hardware.transport.manage') && String(d.driverId) !== String(user._id)) throw ApiError.forbidden('You can only add costs to your own trips', 'NOT_YOUR_DELIVERY'); vehicleId = vehicleId || d.fleetVehicleId;
    if (!JOB_COST_TYPES.includes(input.type)) throw ApiError.badRequest('This cost type belongs to a vehicle, not a single job. Record it against the vehicle.', 'TYPE_NOT_FOR_JOB');
  } else {
    if (!vehicleId) throw ApiError.badRequest('Choose a job or a vehicle', 'TARGET_REQUIRED');
    if (!VEHICLE_COST_TYPES.includes(input.type)) throw ApiError.badRequest('This cost type needs a job', 'JOB_REQUIRED');
  }
  if (branchId) assertBranchAccess(user, branchId);
  if (vehicleId && !(await FleetVehicle.exists({ _id: vehicleId, businessId }))) throw ApiError.badRequest('Vehicle not found', 'VEHICLE_NOT_FOUND');
  let amount = input.amount; let paid = input.paid !== false; const extra = {};
  if (input.expenseId) {
    const e = await Expense.findOne({ _id: input.expenseId, businessId, status: 'APPROVED' }); if (!e) throw ApiError.badRequest('Expense not found or not approved', 'EXPENSE_NOT_FOUND');
    if ((e.kind || 'OPERATING') !== 'OPERATING') throw ApiError.badRequest('Only an operating expense can be allocated to transport', 'EXPENSE_KIND');
    const free = unallocated(e.amount, await allocatedOf(businessId, e._id));
    amount = amount || free;
    if (amount > free) throw ApiError.conflict(`Only ${money(free)} of this expense is left to allocate. The rest is already counted elsewhere.`, 'OVER_ALLOCATED');
    paid = true;
  }
  if (!amount) throw ApiError.badRequest('Amount is required', 'AMOUNT_REQUIRED');
  if (input.odometerKm && vehicleId) { const v = await FleetVehicle.findById(vehicleId).select('odometerKm'); if (input.odometerKm < v.odometerKm) throw ApiError.badRequest(`Odometer is below the last reading (${v.odometerKm} km)`, 'ODOMETER_BACKWARDS'); await FleetVehicle.updateOne({ _id: vehicleId }, { $max: { odometerKm: input.odometerKm } }); }
  const c = await TransportCost.create({ businessId, branchId, deliveryId: d?._id, fleetVehicleId: vehicleId, type: input.type, amount, date: input.date || new Date(), payee: input.payee, payeeUserId: input.payeeUserId, paid, paidAt: paid ? new Date() : undefined, paymentMethod: input.paymentMethod, reference: input.reference, litres: input.litres, odometerKm: input.odometerKm, downtimeDays: input.downtimeDays, expenseId: input.expenseId, note: input.note, ...extra, createdBy: user._id });
  if (d) await recomputeJobCost(d._id);
  if (input.downtimeDays && vehicleId) { /* downtime is reported, the dispatcher sets MAINTENANCE on the vehicle when it is actually off the road */ }
  await log(businessId, user, 'hardware.transport.cost', 'TransportCost', c._id, { type: c.type, amount: c.amount, deliveryId: c.deliveryId, expenseId: c.expenseId }, branchId);
  return c;
}
async function voidCost(businessId, user, id, reason) {
  const c = await TransportCost.findOne({ _id: id, businessId }); if (!c) throw ApiError.notFound('Cost not found'); if (c.voided) throw ApiError.conflict('Already voided', 'ALREADY_VOIDED');
  c.voided = true; c.voidReason = reason; c.voidedBy = user._id; c.voidedAt = new Date(); await c.save();
  if (c.deliveryId) { await recomputeJobCost(c.deliveryId); if (!(await TransportCost.exists({ deliveryId: c.deliveryId, voided: false }))) await DeliveryOrder.updateOne({ _id: c.deliveryId }, { $set: { cost: 0 } }); }
  await log(businessId, user, 'hardware.transport.cost.void', 'TransportCost', c._id, { reason }, c.branchId); return c;
}
async function payCost(businessId, user, id, { paymentMethod, reference }) {
  const c = await TransportCost.findOne({ _id: id, businessId }); if (!c || c.voided) throw ApiError.notFound('Cost not found'); if (c.paid) throw ApiError.conflict('Already paid', 'ALREADY_PAID');
  c.paid = true; c.paidAt = new Date(); c.paymentMethod = paymentMethod; c.reference = reference; await c.save(); await log(businessId, user, 'hardware.transport.cost.pay', 'TransportCost', c._id, { paymentMethod, reference }, c.branchId); return c;
}
async function listCosts(businessId, user, { deliveryId, fleetVehicleId, type, paid, from, to, branchId, page = 1, limit = 50 }) {
  if (branchId) assertBranchAccess(user, branchId);
  const q = { businessId, voided: false }; if (deliveryId) q.deliveryId = deliveryId; if (fleetVehicleId) q.fleetVehicleId = fleetVehicleId; if (type) q.type = type; if (paid !== undefined) q.paid = paid; if (branchId) q.branchId = branchId;
  if (from || to) q.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [rows, total] = await Promise.all([TransportCost.find(q).populate('fleetVehicleId', 'plate').sort({ date: -1 }).skip((page - 1) * limit).limit(limit), TransportCost.countDocuments(q)]);
  return { total, page, rows };
}

// ---------- charge payments (deposit / part payment / refund) ----------
async function addPayment(businessId, user, id, { kind = 'PAYMENT', amount, method, reference }) {
  const d = await loadJob(businessId, id);
  if (d.status === 'CANCELLED' && kind !== 'REFUND') throw ApiError.conflict('This job is cancelled', 'CLOSED');
  if (['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'].indexOf(method) < 0) throw ApiError.badRequest('Unknown payment method', 'METHOD');
  if (method !== 'CASH' && !reference) throw ApiError.badRequest('A transaction reference is required', 'REFERENCE_REQUIRED');
  if (reference && d.payments.some((p) => p.reference === reference)) throw ApiError.conflict('This reference is already recorded on this job', 'DUPLICATE_REFERENCE');
  if (kind === 'REFUND') { if (!hasPermission(user, 'hardware.transport.manage')) throw ApiError.forbidden('Only a manager can refund', 'FORBIDDEN'); if (amount > d.paidTotal) throw ApiError.badRequest('Cannot refund more than was paid', 'OVER_REFUND'); }
  else if (d.paidTotal + amount > d.charge) throw ApiError.badRequest(`Only ${money(d.charge - d.paidTotal)} is still owed on this job`, 'OVERPAYMENT');
  d.payments.push({ kind, amount, method, reference, at: new Date(), by: user._id });
  d.paidTotal = Math.max(0, d.paidTotal + (kind === 'REFUND' ? -amount : amount)); d.paymentStatus = paymentState(d.charge, d.paidTotal);
  try { await d.save(); } catch (e) { dup(e, 'This transaction reference is already used on another job', 'DUPLICATE_REFERENCE'); }
  await log(businessId, user, 'hardware.transport.payment', 'DeliveryOrder', d._id, { kind, amount, method, reference }, d.branchId);
  return d;
}

// ---------- trip log ----------
async function recordReturn(businessId, user, id, { odometerEnd, odometerStart, returnedAt, returnTrip }) {
  const d = await loadJob(businessId, id);
  if (odometerStart !== undefined) d.odometerStart = odometerStart;
  if (odometerEnd !== undefined) { if (d.odometerStart !== undefined && odometerEnd < d.odometerStart) throw ApiError.badRequest('End reading is below the start reading', 'ODOMETER'); d.odometerEnd = odometerEnd; if (d.odometerStart !== undefined) d.kmTravelled = odometerEnd - d.odometerStart; if (d.fleetVehicleId) await FleetVehicle.updateOne({ _id: d.fleetVehicleId }, { $max: { odometerKm: odometerEnd } }); }
  d.returnedAt = returnedAt || new Date(); if (returnTrip !== undefined) d.returnTrip = returnTrip;
  d.events.push({ status: d.status, at: new Date(), by: user._id, note: 'Truck returned' }); await d.save(); return d;
}
async function jobSummary(businessId, id) {
  const d = await DeliveryOrder.findOne({ _id: id, businessId }).populate('fleetVehicleId', 'plate type').populate('driverId', 'name').lean(); if (!d) throw ApiError.notFound('Job not found');
  const costs = await TransportCost.find({ businessId, deliveryId: id, voided: false }).lean();
  const p = jobProfit({ charge: d.charge, absorbed: d.pricing?.absorbed, costs });
  const by = {}; costs.forEach((c) => { by[c.type] = (by[c.type] || 0) + c.amount; });
  return { jobId: d._id, number: d.number, status: d.status, revenue: money(p.revenue), cost: money(p.cost), profit: money(p.profit), marginPct: p.marginPct, costByType: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, money(v)])), paid: money(d.paidTotal), outstanding: money(Math.max(0, d.charge - d.paidTotal)), paymentStatus: d.paymentStatus, kmTravelled: d.kmTravelled, unpaidCosts: money(costs.filter((c) => !c.paid).reduce((s, c) => s + c.amount, 0)) };
}

// ---------- reports ----------
const range = (f, field) => (f.from || f.to ? { [field]: { ...(f.from ? { $gte: f.from } : {}), ...(f.to ? { $lte: f.to } : {}) } } : {});
async function report(businessId, user, { from, to, branchId }) {
  if (branchId) assertBranchAccess(user, branchId);
  const jq = { businessId, status: { $ne: 'CANCELLED' }, ...(branchId ? { branchId } : {}), ...range({ from, to }, 'scheduledFor') };
  const jobs = await DeliveryOrder.find(jq).select('number status charge cost pricing zone address fleetVehicleId driverId kmTravelled paymentStatus paidTotal customerId scheduledFor failedReason').lean();
  const costs = await TransportCost.find({ businessId, voided: false, deliveryId: { $in: jobs.map((j) => j._id) } }).lean();
  const byJobCost = new Map(); costs.forEach((c) => byJobCost.set(String(c.deliveryId), [...(byJobCost.get(String(c.deliveryId)) || []), c]));
  const rows = jobs.map((j) => { const cs = byJobCost.get(String(j._id)) || []; const delivered = j.status === 'DELIVERED'; const p = jobProfit({ charge: delivered ? j.charge : 0, absorbed: j.pricing?.absorbed, costs: cs.length ? cs : [{ amount: j.cost || 0 }] }); return { ...j, ...p, delivered }; });
  const group = (keyFn, nameFn) => { const m = new Map(); for (const r of rows) { const k = keyFn(r) || '(none)'; const x = m.get(k) || { key: k, jobs: 0, revenue: 0, cost: 0, km: 0 }; x.jobs += 1; x.revenue += r.revenue; x.cost += r.cost; x.km += r.kmTravelled || 0; m.set(k, x); } return [...m.values()].map((x) => ({ ...x, revenue: money(x.revenue), cost: money(x.cost), profit: money(x.revenue - x.cost) })).sort((a, b) => b.profit - a.profit); };
  const vs = await FleetVehicle.find({ businessId }).select('plate').lean(); const V = new Map(vs.map((v) => [String(v._id), v.plate]));
  const us = await User.find({ _id: { $in: jobs.map((j) => j.driverId).filter(Boolean) } }).select('name').lean(); const U = new Map(us.map((u) => [String(u._id), u.name]));
  const fuel = costs.filter((c) => c.type === 'FUEL'); const fuelTotal = fuel.reduce((s, c) => s + c.amount, 0); const kmTotal = rows.reduce((s, r) => s + (r.kmTravelled || 0), 0);
  const tripsWithFuel = new Set(fuel.map((c) => String(c.deliveryId))).size;
  const delivered = rows.filter((r) => r.delivered); const failed = rows.filter((r) => r.status === 'FAILED');
  const revenue = rows.reduce((s, r) => s + r.revenue, 0); const cost = rows.reduce((s, r) => s + r.cost, 0);
  const routes = group((r) => r.zone);
  const unpaid = await TransportCost.aggregate([{ $match: { businessId: oid(businessId), voided: false, paid: false, ...range({ from, to }, 'date') } }, { $group: { _id: { $ifNull: ['$payee', '(unspecified)'] }, owed: { $sum: '$amount' }, items: { $sum: 1 } } }, { $sort: { owed: -1 } }]);
  const vehCosts = await TransportCost.aggregate([{ $match: { businessId: oid(businessId), voided: false, fleetVehicleId: { $ne: null }, type: { $in: ['SERVICE', 'REPAIR', 'TYRES', 'INSURANCE', 'INSPECTION', 'LICENCE'] }, ...range({ from, to }, 'date') } }, { $group: { _id: { v: '$fleetVehicleId', t: '$type' }, amount: { $sum: '$amount' }, downtime: { $sum: { $ifNull: ['$downtimeDays', 0] } } } }]);
  const maint = new Map(); vehCosts.forEach((x) => { const m = maint.get(String(x._id.v)) || { cost: 0, downtimeDays: 0 }; m.cost += x.amount; m.downtimeDays += x.downtime; maint.set(String(x._id.v), m); });
  const periodDays = from && to ? Math.max(1, Math.ceil((to - from) / DAY)) : 30;
  const used = new Map(); rows.forEach((r) => { if (r.fleetVehicleId && ['DELIVERED', 'IN_TRANSIT', 'FAILED'].includes(r.status)) { const k = String(r.fleetVehicleId); const s = used.get(k) || new Set(); s.add(new Date(r.scheduledFor).toISOString().slice(0, 10)); used.set(k, s); } });
  const vehicleRows = vs.map((v) => ({ vehicleId: v._id, plate: v.plate, daysUsed: (used.get(String(v._id)) || new Set()).size, utilisationPct: Math.round(((used.get(String(v._id)) || new Set()).size / periodDays) * 1000) / 10, maintenanceCost: money(maint.get(String(v._id))?.cost), downtimeDays: maint.get(String(v._id))?.downtimeDays || 0 }));
  const outstanding = rows.filter((r) => r.charge > r.paidTotal && !r.pricing?.absorbed).map((r) => ({ number: r.number, customerId: r.customerId, charge: money(r.charge), paid: money(r.paidTotal), owed: money(r.charge - r.paidTotal) }));
  return {
    totals: { jobs: rows.length, delivered: delivered.length, failed: failed.length, revenue: money(revenue), directCost: money(cost), profit: money(revenue - cost), avgMargin: revenue ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null, costPerDelivery: delivered.length ? money(cost / delivered.length) : 0 },
    fuel: { total: money(fuelTotal), perTrip: tripsWithFuel ? money(fuelTotal / tripsWithFuel) : 0, perKm: kmTotal ? money(fuelTotal / kmTotal) : null, litres: fuel.reduce((s, c) => s + (c.litres || 0), 0), km: kmTotal },
    byJob: rows.map((r) => ({ jobId: r._id, number: r.number, status: r.status, zone: r.zone, revenue: money(r.revenue), cost: money(r.cost), profit: money(r.profit) })).sort((a, b) => a.profit - b.profit).slice(0, 200),
    byVehicle: group((r) => (r.fleetVehicleId ? V.get(String(r.fleetVehicleId)) : null)), byDriver: group((r) => (r.driverId ? U.get(String(r.driverId)) : null)), byRoute: routes,
    lossMakingRoutes: routes.filter((r) => r.profit < 0), profitableRoutes: routes.filter((r) => r.profit > 0).slice(0, 10),
    failed: { count: failed.length, cost: money(failed.reduce((s, r) => s + r.cost, 0)), jobs: failed.map((r) => ({ number: r.number, reason: r.failedReason, cost: money(r.cost) })) },
    outstandingCharges: { total: money(rows.filter((r) => r.charge > r.paidTotal && !r.pricing?.absorbed).reduce((s, r) => s + (r.charge - r.paidTotal), 0)), jobs: outstanding },
    unpaidCosts: unpaid.map((u) => ({ payee: u._id, owed: money(u.owed), items: u.items })),
    vehicles: vehicleRows,
    note: 'Revenue counts delivered jobs. Costs come from cost lines (counted once); an expense linked to a job is taken out of operating expenses.',
  };
}
module.exports = { listVehicles, saveVehicle, vehicleAlerts, listRates, saveRate, removeRate, priceFor, assign, addCost, voidCost, payCost, listCosts, addPayment, recordReturn, jobSummary, report, recomputeJobCost, allocatedOf };
