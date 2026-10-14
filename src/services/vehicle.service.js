const Vehicle = require('../models/Vehicle');
const JobCard = require('../models/JobCard');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { normalizePlate, normalizeVin } = require('../utils/vehicle');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function ownerFrom(businessId, { customerId, ownerName, ownerPhone }) {
  if (!customerId) return { ownerName, ownerPhone };
  const c = await Customer.findOne({ _id: customerId, businessId }).select('name phone');
  if (!c) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  return { customerId: c._id, ownerName: ownerName || c.name, ownerPhone: ownerPhone || c.phone };
}

function dupError(e) {
  if (e?.code !== 11000) return e;
  const vin = /vin/.test(e.message || '');
  return ApiError.conflict(vin ? 'A vehicle with this VIN is already registered' : 'A vehicle with this number plate is already registered', vin ? 'VIN_EXISTS' : 'PLATE_EXISTS');
}

async function createVehicle(businessId, userId, input) {
  const plate = normalizePlate(input.plate);
  if (plate.length < 3) throw ApiError.badRequest('Enter a valid number plate', 'INVALID_PLATE');
  let vin;
  if (input.vin) {
    vin = normalizeVin(input.vin);
    if (!vin) throw ApiError.badRequest('A VIN is 17 letters/digits (no I, O or Q)', 'INVALID_VIN');
  }
  const owner = await ownerFrom(businessId, input);
  try {
    const v = await Vehicle.create({
      businessId, ...owner, plate, plateDisplay: String(input.plate).trim().toUpperCase(), vin,
      make: input.make, model: input.model, year: input.year, color: input.color, engineNo: input.engineNo,
      fuelType: input.fuelType, transmission: input.transmission, odometerKm: input.odometerKm || 0,
      insuranceExpiry: input.insuranceExpiry, notes: input.notes, createdBy: userId,
    });
    await AuditLog.create({ businessId, userId, action: 'vehicle.create', entityType: 'Vehicle', entityId: v._id, newValue: { plate } });
    return v;
  } catch (e) { throw dupError(e); }
}

async function updateVehicle(businessId, userId, id, input) {
  const v = await Vehicle.findOne({ _id: id, businessId });
  if (!v) throw ApiError.notFound('Vehicle not found');
  if (input.plate !== undefined) {
    const plate = normalizePlate(input.plate);
    if (plate.length < 3) throw ApiError.badRequest('Enter a valid number plate', 'INVALID_PLATE');
    v.plate = plate; v.plateDisplay = String(input.plate).trim().toUpperCase();
  }
  if (input.vin !== undefined) {
    if (input.vin === null || input.vin === '') v.vin = undefined;
    else { const vin = normalizeVin(input.vin); if (!vin) throw ApiError.badRequest('A VIN is 17 letters/digits (no I, O or Q)', 'INVALID_VIN'); v.vin = vin; }
  }
  if (input.customerId !== undefined || input.ownerName !== undefined || input.ownerPhone !== undefined) {
    Object.assign(v, await ownerFrom(businessId, { customerId: input.customerId ?? v.customerId, ownerName: input.ownerName, ownerPhone: input.ownerPhone }));
  }
  for (const k of ['make', 'model', 'year', 'color', 'engineNo', 'fuelType', 'transmission', 'insuranceExpiry', 'notes', 'status']) if (input[k] !== undefined) v[k] = input[k];
  if (input.odometerKm !== undefined) {
    if (input.odometerKm < v.odometerKm) throw ApiError.badRequest(`Odometer cannot go backwards (last reading ${v.odometerKm} km)`, 'ODOMETER_BACKWARDS');
    v.odometerKm = input.odometerKm;
  }
  try { await v.save(); } catch (e) { throw dupError(e); }
  await AuditLog.create({ businessId, userId, action: 'vehicle.update', entityType: 'Vehicle', entityId: v._id, newValue: Object.keys(input) });
  return v;
}

async function getVehicle(businessId, id) {
  const v = await Vehicle.findOne({ _id: id, businessId });
  if (!v) throw ApiError.notFound('Vehicle not found');
  return v;
}

/** Counter lookup: by plate (spaces/dashes/case ignored) or VIN. */
async function lookup(businessId, { plate, vin }) {
  const q = { businessId };
  if (plate) q.plate = normalizePlate(plate);
  else if (vin) { const n = normalizeVin(vin); if (!n) throw ApiError.badRequest('Invalid VIN', 'INVALID_VIN'); q.vin = n; }
  else throw ApiError.badRequest('Give a plate or VIN', 'LOOKUP_REQUIRED');
  const vehicle = await Vehicle.findOne(q);
  if (!vehicle) throw ApiError.notFound('Vehicle not registered. Register it first.');
  const open = await JobCard.findOne({ businessId, vehicleId: vehicle._id, status: { $nin: ['COLLECTED', 'CANCELLED'] } }).select('jobNumber status');
  const last = await JobCard.findOne({ businessId, vehicleId: vehicle._id, status: 'COLLECTED' }).sort({ collectedAt: -1 }).select('jobNumber collectedAt odometerOut workWarrantyUntil complaint');
  return { vehicle, openJobCard: open, lastService: last, underWorkWarranty: !!(last?.workWarrantyUntil && last.workWarrantyUntil >= new Date()) };
}

async function listVehicles(businessId, { customerId, search, status, page = 1, limit = 20 }) {
  const filter = { businessId };
  if (customerId) filter.customerId = customerId;
  if (status) filter.status = status;
  if (search) {
    const re = new RegExp(esc(search), 'i');
    const plate = normalizePlate(search);
    filter.$or = [{ ownerName: re }, { ownerPhone: re }, { make: re }, { model: re }, ...(plate ? [{ plate: new RegExp(esc(plate)) }] : [])];
  }
  const [items, total] = await Promise.all([
    Vehicle.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit),
    Vehicle.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Every collected job on this vehicle, newest first: the vehicle's service history. */
async function serviceHistory(businessId, id, { page = 1, limit = 20 }) {
  const v = await getVehicle(businessId, id);
  const filter = { businessId, vehicleId: v._id, status: 'COLLECTED' };
  const [items, total] = await Promise.all([
    JobCard.find(filter).select('jobNumber collectedAt odometerIn odometerOut complaint diagnosis labourLines parts total workWarrantyUntil comebackOf nextServiceKm nextServiceDate')
      .sort({ collectedAt: -1 }).skip((page - 1) * limit).limit(limit),
    JobCard.countDocuments(filter),
  ]);
  return { vehicle: v, items, total, page, limit, pages: Math.ceil(total / limit) };
}

/** Vehicles whose next service date is within `days`, or whose odometer is within `kmWindow` of the next service km. */
async function dueForService(businessId, { days = 14, kmWindow = 500 }) {
  const horizon = new Date(Date.now() + days * 86400000);
  const candidates = await Vehicle.find({
    businessId, status: 'active',
    $or: [{ nextServiceDate: { $lte: horizon } }, { nextServiceKm: { $gt: 0 } }],
  }).select('plateDisplay plate make model ownerName ownerPhone odometerKm nextServiceKm nextServiceDate lastServiceAt').sort({ nextServiceDate: 1 }).limit(1000);
  return candidates.filter((v) => (v.nextServiceDate && v.nextServiceDate <= horizon) || (v.nextServiceKm && v.odometerKm >= v.nextServiceKm - kmWindow));
}

module.exports = { createVehicle, updateVehicle, getVehicle, lookup, listVehicles, serviceHistory, dueForService };