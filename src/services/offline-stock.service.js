'use strict';
/**
 * Offline STOCK events. A cashier whose product is out of stock can receive / adjust it at the till, even with no
 * internet. The till stores STOCK_RECEIVE / STOCK_ADJUST in the SAME ordered outbox as its sales (outboxSeq), so the
 * server replays them in order: stock is received first, then the sale that needed it.
 *
 * ATOMIC + IDEMPOTENT: the idempotency marker (OfflineStockEvent, unique businessId + deviceId + clientEventId) and the
 * whole stock movement (ledger row, batch, serials, cost update, audit log) are written in ONE MongoDB transaction.
 *  - crash / error before commit  -> nothing is stored, not even the marker, so the till's retry applies the event.
 *  - already committed            -> the retry gets `duplicate` and stock is never moved twice.
 *  - two retries at the same time -> the unique key lets exactly one commit; the other becomes `duplicate`.
 * Only a duplicate-key error on THAT marker key, with the marker really committed, counts as `duplicate`. Any other
 * duplicate-key error (batch, serial...) is a real failure and is surfaced, never swallowed.
 * The cashier's permission is re-checked here against the user record. Hard failures (no permission, product deleted,
 * batch details missing) become an IngestRejection: kept in quarantine for the owner (discard only), never lost.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const OfflineStockEvent = require('../models/OfflineStockEvent');
const inventoryService = require('./inventory.service');
const { userHasPermission } = require('../middleware/auth');
const { IngestRejection } = require('./offline-sale.service');

const keyOf = (businessId, device, event) => ({ businessId, deviceId: device.deviceId, clientEventId: event.clientEventId });

/** True only for an E11000 raised by the offline-event marker's own unique index (not batch / serial / anything else). */
function isMarkerDuplicate(err) {
  if (!err || err.code !== 11000) return false;
  const kp = err.keyPattern || (err.errorResponse && err.errorResponse.keyPattern);
  if (kp) return 'clientEventId' in kp && 'deviceId' in kp && 'businessId' in kp;
  return /offlinestockevents?\b/i.test(String(err.message || '')) && /clientEventId/.test(String(err.message || ''));
}

const committed = async (key) => !!(await OfflineStockEvent.exists(key));

async function ingest({ business, device, claims, event, eventType, permission, apply }) {
  const businessId = business._id;
  const key = keyOf(businessId, device, event);

  const user = await User.findOne({ _id: claims.sub, businessId });
  if (!user) throw new IngestRejection('CASHIER_NOT_FOUND', 'The cashier account no longer exists', { releasable: false });
  if (user.status !== 'active') throw new IngestRejection('CASHIER_INACTIVE', 'The cashier account is not active', { releasable: false });
  if (!userHasPermission(user, permission)) {
    throw new IngestRejection('STOCK_NOT_PERMITTED', `${user.name} does not have the "${permission}" permission, so this stock change was not applied`, { releasable: false });
  }

  if (await committed(key)) return { status: 'duplicate' }; // fast path: this exact event was already applied

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // marker + stock movement commit together or not at all
      await OfflineStockEvent.create([{ ...key, eventType }], { session });
      await apply(user, session);
    });
    return { status: 'created' };
  } catch (err) {
    if (isMarkerDuplicate(err) && (await committed(key))) return { status: 'duplicate' }; // a concurrent retry committed first
    if (err && err.isOperational && err.statusCode >= 400 && err.statusCode < 500) {
      throw new IngestRejection(err.code || 'STOCK_REJECTED', err.message, { releasable: false });
    }
    throw err; // unexpected (or an unrelated duplicate key): nothing was stored, the till retries
  } finally {
    session.endSession();
  }
}

const tag = (device) => `at till ${device.deviceCode || ''}`.trim();

const ingestStockReceive = ({ business, device, claims, event }) => ingest({
  business, device, claims, event, eventType: 'STOCK_RECEIVE', permission: 'inventory.receive',
  apply: (user, session) => inventoryService.receiveStock(business._id, device.branchId, user._id, {
    productId: event.productId, variantId: event.variantId, quantity: event.quantity,
    costPrice: event.costPriceCents, batchNumber: event.batchNumber, expiryDate: event.expiryDate, manufacturingDate: event.manufacturingDate,
    reason: `${event.reason || 'Received'} (offline, ${tag(device)})`, location: 'RETAIL', updateCost: true, session,
  }),
});

const ingestStockAdjust = ({ business, device, claims, event }) => ingest({
  business, device, claims, event, eventType: 'STOCK_ADJUST', permission: 'inventory.adjust',
  apply: (user, session) => inventoryService.adjustStock(business._id, device.branchId, user._id, {
    productId: event.productId, variantId: event.variantId, quantity: event.quantity, type: event.adjustType,
    reason: `${event.reason} (offline, ${tag(device)})`, location: 'RETAIL', session,
  }),
});

module.exports = { ingestStockReceive, ingestStockAdjust, isMarkerDuplicate };
