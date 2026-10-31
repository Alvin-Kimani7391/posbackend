/** Deliveries: schedule, assign vehicle + driver, status flow, proof of delivery (signature / photo / OTP), cost vs charge. Money = integer cents. */
const crypto = require('crypto');
const DeliveryOrder = require('../../models/DeliveryOrder');
const Quotation = require('../../models/Quotation');
const Sale = require('../../models/Sale');
const Customer = require('../../models/Customer');
const User = require('../../models/User');
const HardwareProfile = require('../../models/HardwareProfile');
const AuditLog = require('../../models/AuditLog');
const { nextSequence, pad } = require('../../models/Counter');
const { hasPermission } = require('../../utils/permissionCheck');
const { assertBranchAccess } = require('../../utils/branchAccess');
const transport = require('./transport.service');
const { paymentState } = require('./transport-pricing');
const TransportCost = require('../../models/TransportCost');
const FleetVehicle = require('../../models/FleetVehicle');
const { DELIVERY_FLOW } = require('../../constants/hardware');
const { ROLES } = require('../../constants/roles');
const ApiError = require('../../utils/ApiError');

const hashOtp = (id, otp) => crypto.createHash('sha256').update(`${id}:${otp}`).digest('hex');
const ev = (d, user, status, note) => d.events.push({ status, at: new Date(), by: user?._id, note });
const canManage = (u) => hasPermission(u, 'hardware.deliveries');
/** pure: is this status move allowed? */
const canMove = (from, to) => (DELIVERY_FLOW[from] || []).includes(to);

async function load(businessId, user, id, select = '') {
  const d = await DeliveryOrder.findOne({ _id: id, businessId }).select(select);
  if (!d) throw ApiError.notFound('Delivery not found');
  if (!canManage(user) && String(d.driverId) !== String(user._id)) throw ApiError.forbidden('This delivery is not assigned to you', 'NOT_YOUR_DELIVERY');
  return d;
}
async function checkDriver(businessId, driverId) {
  const u = await User.findOne({ _id: driverId, businessId, status: 'active', role: { $in: [ROLES.DRIVER, ROLES.DELIVERY_RIDER, ROLES.STOREKEEPER, ROLES.DISPATCHER] } }).select('name');
  if (!u) throw ApiError.badRequest('Driver not found (use a staff member with the driver role)', 'DRIVER_NOT_FOUND');
}

async function create(businessId, user, input) {
  assertBranchAccess(user, input.branchId);
  let items = input.items || []; let customerId = input.customerId; let address = input.address; let projectId; let quotationId = input.quotationId; let saleId = input.saleId;
  if (quotationId) { const q = await Quotation.findOne({ _id: quotationId, businessId }); if (!q) throw ApiError.notFound('Quotation not found'); customerId = customerId || q.customerId; address = address || q.deliveryAddress; projectId = q.projectId; if (!items.length) items = q.items.filter((l) => l.quantity - l.fulfilledQty > 0).map((l) => ({ productId: l.productId, variantId: l.variantId, name: l.nameSnapshot, unitName: l.unitName, quantity: Math.round((l.quantity - l.fulfilledQty) * 1000) / 1000 })); }
  if (saleId) { const s = await Sale.findOne({ _id: saleId, businessId }); if (!s) throw ApiError.notFound('Sale not found'); customerId = customerId || s.customerId; if (!items.length) items = s.items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.nameSnapshot, unitName: i.unitName, quantity: i.quantity })); }
  const transportOnly = input.kind === 'TRANSPORT_ONLY';
  if (transportOnly && !input.collectionPoint) throw ApiError.badRequest('Say where the load is collected from', 'COLLECTION_REQUIRED');
  if (!items.length && !transportOnly) throw ApiError.badRequest('Add the goods being delivered', 'NO_ITEMS');
  if (!address) throw ApiError.badRequest('A delivery address is required', 'ADDRESS_REQUIRED');
  if (customerId && !(await Customer.exists({ _id: customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  if (input.driverId) await checkDriver(businessId, input.driverId);
  const profs = await HardwareProfile.find({ businessId, productId: { $in: items.map((i) => i.productId) } }).select('productId handling').lean(); const H = new Map(profs.map((p) => [String(p.productId), p.handling]));
  // price: a typed charge, or worked out from the transport rate card (one rate per component, never double-charged)
  let charge = input.charge || 0; let pricing;
  if (input.pricing) {
    const orderValue = input.pricing.ctx?.orderValue;
    const p = await transport.priceFor(businessId, { ...input.pricing, ctx: { ...(input.pricing.ctx || {}), orderValue, weightKg: input.pricing.ctx?.weightKg ?? input.loadWeightKg, distanceKm: input.pricing.ctx?.distanceKm ?? input.distanceKm, zone: input.pricing.ctx?.zone ?? input.zone } });
    if (input.pricing.negotiatedTotal !== undefined && !canManage(user)) throw ApiError.forbidden('Only a dispatcher can set a negotiated price', 'FORBIDDEN');
    charge = p._cents.chargeToCustomer; pricing = { lines: p._cents.lines, subtotal: p._cents.subtotal, negotiated: p.negotiated, waivedFree: p.waivedFree, absorbed: p.absorbed };
  }
  const d = await DeliveryOrder.create({ kind: transportOnly ? 'TRANSPORT_ONLY' : 'DELIVERY', collectionPoint: input.collectionPoint, zone: input.zone, distanceKm: input.distanceKm, loadWeightKg: input.loadWeightKg, loadVolumeM3: input.loadVolumeM3, loadNote: input.loadNote, loaders: input.loaders, subcontractor: input.subcontractor, pricing, paymentStatus: paymentState(charge, 0), businessId, branchId: input.branchId, number: `DEL-${pad(await nextSequence(businessId, 'hardware:delivery'))}`, saleId, quotationId, projectId, customerId, contactName: input.contactName, contactPhone: input.contactPhone, address, scheduledFor: input.scheduledFor, window: input.window, vehicle: input.vehicle, driverId: input.driverId, items: items.map((i) => ({ productId: i.productId, variantId: i.variantId, name: i.name, unitName: i.unitName, quantity: i.quantity, handling: H.get(String(i.productId)) || [] })), charge, cost: input.cost || 0, notes: input.notes, events: [{ status: 'PENDING', at: new Date(), by: user._id, note: 'Scheduled' }], createdBy: user._id });
  await AuditLog.create({ businessId, branchId: d.branchId, userId: user._id, action: 'hardware.delivery.create', entityType: 'DeliveryOrder', entityId: d._id, newValue: { number: d.number } });
  return d;
}
async function update(businessId, user, id, input) {
  const d = await load(businessId, user, id);
  if (!canManage(user)) throw ApiError.forbidden('Only a dispatcher can change a delivery', 'FORBIDDEN');
  if (['DELIVERED', 'CANCELLED'].includes(d.status)) throw ApiError.conflict('This delivery is closed', 'CLOSED');
  if (input.driverId) await checkDriver(businessId, input.driverId);
  const scheduling = ['address', 'scheduledFor', 'window', 'vehicle', 'driverId', 'contactName', 'contactPhone', 'notes'];
  if (['IN_TRANSIT'].includes(d.status) && scheduling.some((k) => input[k] !== undefined)) throw ApiError.conflict('The truck is on the road. Only the cost can change now.', 'IN_TRANSIT');
  for (const k of [...scheduling, 'collectionPoint', 'zone', 'distanceKm', 'loadWeightKg', 'loadVolumeM3', 'loadNote', 'loaders', 'subcontractor']) if (input[k] !== undefined) d[k] = input[k];
  if (input.charge !== undefined) { if (input.charge < d.paidTotal) throw ApiError.conflict('The customer has already paid more than this charge. Refund first.', 'BELOW_PAID'); d.charge = input.charge; d.paymentStatus = paymentState(d.charge, d.paidTotal); }
  if (input.cost !== undefined) { if (await TransportCost.exists({ deliveryId: d._id, voided: false })) throw ApiError.conflict('This job has itemised cost lines. Add or void a cost line instead, so nothing is counted twice.', 'USE_COST_LINES'); d.cost = input.cost; }
  ev(d, user, d.status, 'Updated'); await d.save(); return d;
}
async function setStatus(businessId, user, id, status, { note, failedReason } = {}) {
  const d = await load(businessId, user, id);
  if (!canMove(d.status, status)) throw ApiError.conflict(`A ${d.status.toLowerCase().replace('_', ' ')} delivery cannot go to ${status.toLowerCase().replace('_', ' ')}`, 'INVALID_TRANSITION');
  if (status === 'DELIVERED') throw ApiError.badRequest('Record proof of delivery to complete a delivery', 'PROOF_REQUIRED');
  if (['CANCELLED'].includes(status) && !canManage(user)) throw ApiError.forbidden('Only a dispatcher can cancel', 'FORBIDDEN');
  if (status === 'LOADED' && !d.subcontractor?.name && (!d.driverId || !d.vehicle)) throw ApiError.badRequest('Assign a vehicle and a driver before loading', 'ASSIGN_FIRST');
  if (status === 'FAILED') { if (!failedReason || failedReason.trim().length < 3) throw ApiError.badRequest('Say why the delivery failed', 'REASON_REQUIRED'); d.failedReason = failedReason.trim(); d.attempts += 1; }
  if (status === 'PENDING') { d.failedReason = undefined; d.otpHash = undefined; }
  const now = new Date();
  if (status === 'LOADED') d.loadedAt = now;
  if (status === 'IN_TRANSIT') { d.dispatchedAt = now; if (d.odometerStart === undefined && d.fleetVehicleId) { const v = await FleetVehicle.findById(d.fleetVehicleId).select('odometerKm'); if (v) d.odometerStart = v.odometerKm; } }
  if (status === 'FAILED') d.arrivedAt = now;
  d.status = status; ev(d, user, status, note || failedReason); await d.save(); return d;
}
/** Make a one-time code for the customer to read out to the driver. Shown once. */
async function issueOtp(businessId, user, id) {
  const d = await load(businessId, user, id); if (!canManage(user)) throw ApiError.forbidden('Only a dispatcher can issue a code', 'FORBIDDEN');
  if (['DELIVERED', 'CANCELLED'].includes(d.status)) throw ApiError.conflict('This delivery is closed', 'CLOSED');
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  d.otpHash = hashOtp(d._id, otp); d.otpExpiresAt = new Date(Date.now() + 3 * 86400000); d.otpTries = 0; ev(d, user, d.status, 'Delivery code issued'); await d.save();
  return { otp, expiresAt: d.otpExpiresAt, note: 'Give this code to the customer. They read it to the driver on delivery.' };
}
async function deliver(businessId, user, id, { type, receivedBy, otp, signatureUrl, photoUrl, delivered = [] }) {
  const d = await load(businessId, user, id, '+otpHash +otpExpiresAt +otpTries');
  if (d.status !== 'IN_TRANSIT') throw ApiError.conflict('Only a delivery that is on the road can be completed', 'INVALID_STATE');
  if (type === 'OTP') {
    if (!d.otpHash || d.otpExpiresAt < new Date()) throw ApiError.badRequest('No valid delivery code. Ask the dispatcher for a new one.', 'OTP_MISSING');
    if (d.otpTries >= 5) throw ApiError.forbidden('Too many wrong codes. Ask the dispatcher for a new one.', 'OTP_LOCKED');
    const ok = otp && crypto.timingSafeEqual(Buffer.from(hashOtp(d._id, String(otp))), Buffer.from(d.otpHash));
    if (!ok) { d.otpTries += 1; await d.save(); throw ApiError.badRequest('Wrong code', 'OTP_WRONG'); }
  } else if (type === 'SIGNATURE') { if (!receivedBy || !signatureUrl) throw ApiError.badRequest('Name of the person receiving and their signature are required', 'SIGNATURE_REQUIRED'); }
  else if (type === 'PHOTO') { if (!photoUrl) throw ApiError.badRequest('Take a photo of the delivered goods', 'PHOTO_REQUIRED'); }
  const by = new Map(delivered.map((x) => [x.index, x.quantity]));
  d.items.forEach((it, i) => { const q = by.has(i) ? by.get(i) : it.quantity; if (q < 0 || q > it.quantity) throw ApiError.badRequest(`Delivered quantity for ${it.name} is not valid`, 'INVALID_QUANTITY'); it.deliveredQuantity = q; });
  const short = d.items.filter((it) => it.deliveredQuantity < it.quantity).length;
  d.proof = { type, receivedBy, signatureUrl, photoUrl, at: new Date(), by: user._id }; d.status = 'DELIVERED'; d.arrivedAt = new Date(); d.otpHash = undefined;
  ev(d, user, 'DELIVERED', short ? `${short} item(s) delivered short` : undefined); await d.save();
  await AuditLog.create({ businessId, branchId: d.branchId, userId: user._id, action: 'hardware.delivery.done', entityType: 'DeliveryOrder', entityId: d._id, newValue: { type, short } });
  return d;
}
async function list(businessId, user, { status, driverId, customerId, from, to, branchId, page = 1, limit = 30 }) {
  const q = { businessId }; if (status) q.status = status; if (customerId) q.customerId = customerId; if (branchId) q.branchId = branchId;
  q.driverId = canManage(user) ? driverId : user._id; if (q.driverId === undefined) delete q.driverId;
  if (from || to) q.scheduledFor = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  const [rows, total] = await Promise.all([DeliveryOrder.find(q).select('-events').populate('customerId', 'name phone').populate('driverId', 'name').sort({ scheduledFor: 1 }).skip((page - 1) * limit).limit(limit), DeliveryOrder.countDocuments(q)]);
  return { total, page, rows };
}
async function get(businessId, user, id) { const d = await load(businessId, user, id); return DeliveryOrder.findById(d._id).populate('customerId', 'name phone').populate('driverId', 'name phone'); }

module.exports = { canMove, create, update, setStatus, issueOtp, deliver, list, get };
