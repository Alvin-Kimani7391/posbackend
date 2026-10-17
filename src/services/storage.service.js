/**
 * Storage / temperature log. A reading outside its range raises an exception; the stock named in it is QUARANTINED at once
 * and only a pharmacist can release or dispose of it after assessing it. The system never decides whether stock is still safe.
 */
const StorageLog = require('../models/StorageLog');
const Batch = require('../models/Batch');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const batchService = require('./batch.service');
const guard = require('./pharmacy-guard.service');
const { DEFAULT_RANGES } = require('../constants/pharmacy');
const ApiError = require('../utils/ApiError');

function rangeFor(business, place, input) {
  if (input.minC != null && input.maxC != null) return { minC: input.minC, maxC: input.maxC };
  const configured = (business.pharmacySettings?.rooms || []).find((r) => String(r.place).toLowerCase() === String(place).toLowerCase());
  if (configured) return { minC: configured.minC, maxC: configured.maxC };
  return /fridge|cold|refrigerat/i.test(place) ? DEFAULT_RANGES.fridge : DEFAULT_RANGES.room;
}

async function holdBatches(businessId, user, branchId, batchIds, why) {
  const found = await Batch.find({ _id: { $in: batchIds }, businessId, branchId });
  if (found.length !== batchIds.length) throw ApiError.badRequest('One of the batches is not at this branch', 'BATCH_NOT_FOUND');
  for (const b of found) await batchService.quarantineBatch(businessId, user._id, b._id, { reason: why });
}

async function log(businessId, branchId, user, input) {
  const business = await Business.findById(businessId);
  const { minC, maxC } = rangeFor(business, input.place, input);
  const within = input.readingC >= minC && input.readingC <= maxC;
  const entry = await StorageLog.create({ businessId, branchId, place: input.place, readingC: input.readingC, minC, maxC, withinRange: within, note: input.note, recordedBy: user._id });
  if (!within) {
    const ids = input.batchIds || [];
    if (ids.length) await holdBatches(businessId, user, branchId, ids, `Storage exception at ${input.place}: ${input.readingC}C (allowed ${minC} to ${maxC}C)`);
    entry.exception = { status: 'OPEN', batchIds: ids };
    await entry.save();
    await AuditLog.create({ businessId, branchId, userId: user._id, action: 'storage.exception', entityType: 'StorageLog', entityId: entry._id, newValue: { place: input.place, readingC: input.readingC, batches: ids.length } });
  }
  return entry;
}

/** The responsible person names more stock affected by an open exception. It is quarantined straight away. */
async function flagBatches(businessId, user, id, { batchIds }) {
  const e = await StorageLog.findOne({ _id: id, businessId });
  if (!e || !e.exception || e.exception.status !== 'OPEN') throw ApiError.conflict('There is no open exception on this reading', 'NO_OPEN_EXCEPTION');
  const fresh = batchIds.filter((b) => !e.exception.batchIds.map(String).includes(String(b)));
  await holdBatches(businessId, user, e.branchId, fresh, `Storage exception at ${e.place}`);
  e.exception.batchIds = [...e.exception.batchIds, ...fresh];
  await e.save();
  return e;
}

/** Pharmacist decision on every flagged batch: release it back to stock, or dispose of it. */
async function assess(businessId, user, id, { releaseBatchIds = [], disposeBatchIds = [], note }) {
  const business = await Business.findById(businessId);
  if (!guard.credentialOk(user, business, ['PHARMACIST'])) throw ApiError.forbidden('Only a pharmacist can assess a storage exception', 'CREDENTIAL_REQUIRED');
  const e = await StorageLog.findOne({ _id: id, businessId });
  if (!e || !e.exception || e.exception.status !== 'OPEN') throw ApiError.conflict('There is no open exception on this reading', 'NO_OPEN_EXCEPTION');
  const flagged = e.exception.batchIds.map(String).sort();
  const decided = [...releaseBatchIds, ...disposeBatchIds].map(String).sort();
  if (JSON.stringify(flagged) !== JSON.stringify(decided)) throw ApiError.badRequest('Decide what happens to every flagged batch (release or dispose), and no others', 'INCOMPLETE_ASSESSMENT');
  for (const b of releaseBatchIds) await batchService.releaseBatch(businessId, user._id, b, { reason: `Assessed after storage exception: ${note}` });
  for (const b of disposeBatchIds) await batchService.disposeBatch(businessId, user._id, b, { reason: `Storage exception: ${note}`, type: 'DAMAGE' });
  e.exception.status = 'ASSESSED'; e.exception.assessedBy = user._id; e.exception.assessedAt = new Date(); e.exception.assessmentNote = note;
  e.exception.outcome = !disposeBatchIds.length ? 'RELEASED' : !releaseBatchIds.length ? 'DISPOSED' : 'PARTIAL';
  await e.save();
  await AuditLog.create({ businessId, branchId: e.branchId, userId: user._id, action: 'storage.assess', entityType: 'StorageLog', entityId: e._id, newValue: { released: releaseBatchIds.length, disposed: disposeBatchIds.length, note } });
  return e;
}

async function list(businessId, { branchId, openOnly, place, page = 1, limit = 30 } = {}) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId; if (place) filter.place = place; if (openOnly) filter['exception.status'] = 'OPEN';
  const [rows, total] = await Promise.all([StorageLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), StorageLog.countDocuments(filter)]);
  return { logs: rows, total, page, limit };
}

module.exports = { log, flagBatches, assess, list, rangeFor };