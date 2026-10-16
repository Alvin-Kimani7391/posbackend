'use strict';
/**
 * Offline shifts. A supermarket must be able to open its tills even when the internet is down at
 * 7 am, and close them at night. The till opens/closes the shift locally and pushes SHIFT_OPEN /
 * SHIFT_CLOSE in the SAME ordered stream as its sales (outboxSeq), so the server replays them in the
 * order they happened. Nothing is refused over business rules: conflicts are recorded and FLAGGED.
 */
const CashShift = require('../models/CashShift');
const CashRegister = require('../models/CashRegister');
const User = require('../models/User');
const SyncRejection = require('../models/SyncRejection');
const AuditLog = require('../models/AuditLog');
const notificationService = require('./notification.service');
const shiftService = require('./shift.service');
const { getBusinessContext } = require('../utils/businessContext');
const { IngestRejection } = require('./offline-sale.service');

const TOL = 5 * 60 * 1000;
const flag = (code, severity, detail) => ({ code, severity, detail });

async function notifyHigh(businessId, shift, flags, what) {
  const high = [...new Set(flags.filter((f) => f.severity === 'HIGH').map((f) => f.code))];
  if (!high.length) return;
  try {
    await notificationService.notifyManagement(businessId, {
      type: 'OFFLINE_REVIEW',
      title: `Offline shift ${what} needs review`,
      message: `A shift ${what} from an offline till needs a manager's attention: ${high.join(', ')}.`,
      branchId: shift.branchId, entityType: 'CashShift', entityId: shift._id, data: { shiftId: shift._id, flags: high },
    });
  } catch (err) {
    console.error('[offline-shift] notify failed', err.message);
  }
}

async function ingestShiftOpen({ business, device, claims, event: e, syncedAt }) {
  const businessId = business._id;
  const branchId = device.branchId;

  const existing = await CashShift.findOne({ businessId, branchId, deviceId: device.deviceId, clientShiftId: e.clientShiftId });
  if (existing) return { status: 'duplicate', shiftId: existing._id };

  const [cashier, register] = await Promise.all([
    User.findOne({ _id: claims.sub, businessId }),
    CashRegister.findOne({ _id: e.registerId, businessId, branchId }),
  ]);
  if (!cashier) throw new IngestRejection('CASHIER_NOT_FOUND', 'The cashier account no longer exists', { releasable: false });
  if (!register) throw new IngestRejection('REGISTER_NOT_FOUND', 'The register does not exist in this branch', { releasable: false });

  const flags = [];
  let openedAt = e.occurredAt;
  if (openedAt.getTime() > syncedAt.getTime() + TOL) {
    flags.push(flag('FUTURE_DATED', 'HIGH', 'The shift open time was in the future (device clock wrong?); the sync time was used'));
    openedAt = syncedAt;
  }
  if (register.status !== 'active') flags.push(flag('REGISTER_INACTIVE', 'WARN', 'The register was inactive'));
  if (cashier.status !== 'active') flags.push(flag('CASHIER_INACTIVE', 'HIGH', 'The cashier account is not active'));
  if (claims.caps && claims.caps.canOpenShift === false) flags.push(flag('SHIFT_OPEN_NOT_PERMITTED', 'HIGH', 'The cashier did not have permission to open shifts'));

  const [cashierOpen, registerOpen] = await Promise.all([
    CashShift.findOne({ businessId, cashierId: cashier._id, status: 'OPEN' }).select('_id'),
    CashShift.findOne({ businessId, registerId: register._id, status: 'OPEN' }).select('_id'),
  ]);
  if (cashierOpen) flags.push(flag('SHIFT_CONFLICT_CASHIER', 'HIGH', 'This cashier already had another open shift'));
  if (registerOpen) flags.push(flag('SHIFT_CONFLICT_REGISTER', 'HIGH', 'This register already had an open shift'));

  let shift;
  try {
    shift = await CashShift.create({
      businessId, branchId, registerId: register._id, cashierId: cashier._id,
      openingCash: e.openingCashCents, openedAt, status: 'OPEN', currency: (await getBusinessContext(businessId)).currency,
      clientShiftId: e.clientShiftId, deviceId: device.deviceId, isOffline: true, syncedAt,
      offlineFlags: flags, offlineReview: flags.some((f) => f.severity === 'HIGH') ? 'PENDING' : 'NONE',
    });
  } catch (err) {
    if (err.code === 11000) {
      const dup = await CashShift.findOne({ businessId, branchId, deviceId: device.deviceId, clientShiftId: e.clientShiftId });
      if (dup) return { status: 'duplicate', shiftId: dup._id };
    }
    throw err;
  }

  await AuditLog.create({
    businessId, branchId, userId: cashier._id, action: 'shift.open.offline', entityType: 'CashShift', entityId: shift._id,
    newValue: { openingCash: e.openingCashCents, openedAt, deviceCode: device.deviceCode, flags: flags.map((f) => f.code) },
  });
  try {
    await shift.populate('registerId', 'name code');
    await notificationService.notifyShiftOpened(businessId, branchId, shift, cashier);
  } catch (err) {
    console.error('[offline-shift] notifyShiftOpened failed', err.message);
  }
  await notifyHigh(businessId, shift, flags, 'open');
  return { status: shift.offlineReview === 'PENDING' ? 'needs_review' : 'created', shiftId: shift._id, flags };
}

async function ingestShiftClose({ business, device, claims, event: e, syncedAt }) {
  const businessId = business._id;
  const branchId = device.branchId;

  const shift = e.clientShiftId
    ? await CashShift.findOne({ businessId, branchId, deviceId: device.deviceId, clientShiftId: e.clientShiftId })
    : await CashShift.findOne({ _id: e.shiftId, businessId, branchId });
  if (!shift) throw new IngestRejection('SHIFT_NOT_FOUND', 'The shift to close does not exist (its open event may be held for review)', { releasable: false });

  if (shift.status === 'CLOSED') {
    if (shift.offlineCloseId && shift.offlineCloseId === e.clientEventId) return { status: 'duplicate', shiftId: shift._id };
    throw new IngestRejection('SHIFT_ALREADY_CLOSED', 'The shift was already closed on the server', { releasable: false });
  }

  // Atomic claim: only one request can close this shift.
  const claimed = await CashShift.findOneAndUpdate(
    { _id: shift._id, status: 'OPEN', offlineCloseId: { $exists: false } },
    { $set: { offlineCloseId: e.clientEventId } },
    { new: true }
  );
  if (!claimed) return { status: 'duplicate', shiftId: shift._id };

  const flags = [];
  let closedAt = e.occurredAt;
  if (closedAt.getTime() > syncedAt.getTime() + TOL) {
    flags.push(flag('FUTURE_DATED', 'HIGH', 'The shift close time was in the future; the sync time was used'));
    closedAt = syncedAt;
  }
  if (claims.caps && claims.caps.canCloseShift === false) flags.push(flag('SHIFT_CLOSE_NOT_PERMITTED', 'HIGH', 'The cashier did not have permission to close shifts'));
  if (String(claims.sub) !== String(shift.cashierId)) flags.push(flag('CLOSED_BY_OTHER', 'INFO', 'The shift was closed by a different user than the one who opened it'));

  const heldSales = await SyncRejection.exists({
    businessId, deviceId: device.deviceId, eventType: 'SALE', status: { $in: ['HELD', 'REJECTED'] },
    $or: [{ 'payload.clientShiftId': e.clientShiftId || null }, { 'payload.shiftId': e.shiftId || String(shift._id) }],
  });
  if (heldSales) flags.push(flag('SHIFT_CLOSED_WITH_HELD_SALES', 'HIGH', 'Some sales of this shift are held for review, so the cash expectation is incomplete'));

  let closed;
  try {
    closed = await shiftService.closeShift(businessId, claims.sub, shift._id, { denominations: e.denominations, notes: e.notes, closedAt });
  } catch (err) {
    await CashShift.updateOne({ _id: shift._id }, { $unset: { offlineCloseId: 1 } }); // release the claim so a retry can succeed
    throw err;
  }

  const high = flags.some((f) => f.severity === 'HIGH');
  const update = { $set: { closedSyncedAt: new Date() } };
  if (flags.length) update.$push = { offlineFlags: { $each: flags } };
  if (high) update.$set.offlineReview = 'PENDING';
  await CashShift.updateOne({ _id: shift._id }, update);

  await AuditLog.create({
    businessId, branchId, userId: claims.sub, action: 'shift.close.offline', entityType: 'CashShift', entityId: shift._id,
    newValue: { closedAt, deviceCode: device.deviceCode, cashDifference: closed.cashDifference, flags: flags.map((f) => f.code) },
  });
  await notifyHigh(businessId, shift, flags, 'close');
  return { status: high ? 'needs_review' : 'created', shiftId: shift._id, cashDifference: closed.cashDifference, flags };
}

module.exports = { ingestShiftOpen, ingestShiftClose };