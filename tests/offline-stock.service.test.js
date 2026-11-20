/**
 * Offline stock events: the idempotency marker and the stock movement commit in ONE transaction.
 * Needs a replica set for transactions, so it uses mongodb-memory-server's MongoMemoryReplSet (first run downloads mongod).
 */

jest.mock('../src/services/notification.service', () => new Proxy({}, { get: () => async () => [] }));
jest.mock('../src/services/offline-sale.service', () => {
  class IngestRejection extends Error {
    constructor(code, message, { releasable = true } = {}) { super(message); this.code = code; this.releasable = releasable; this.isIngestRejection = true; }
  }
  return { IngestRejection };
});

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const BranchInventory = require('../src/models/BranchInventory');
const InventoryMovement = require('../src/models/InventoryMovement');
const OfflineStockEvent = require('../src/models/OfflineStockEvent');
const AuditLog = require('../src/models/AuditLog');
const inventoryService = require('../src/services/inventory.service');
const { ingestStockReceive, ingestStockAdjust, isMarkerDuplicate } = require('../src/services/offline-stock.service');

const oid = () => new mongoose.Types.ObjectId();
let rs; let businessId; let otherBusinessId; let branchId; let productId; let userId; let cashierId; let device; let claims; let seq = 0;

const qty = async (pid = productId, bid = businessId) => ((await BranchInventory.findOne({ businessId: bid, branchId, productId: pid })) || {}).quantity || 0;
const recv = (over = {}) => ({ type: 'STOCK_RECEIVE', clientEventId: `evt-recv-${(seq += 1)}-padding`, outboxSeq: seq, occurredAt: new Date(), productId, quantity: 10, ...over });
const adj = (over = {}) => ({ type: 'STOCK_ADJUST', clientEventId: `evt-adj-${(seq += 1)}-padding`, outboxSeq: seq, occurredAt: new Date(), productId, quantity: 3, adjustType: 'ADJUSTMENT_IN', reason: 'count', ...over });
const call = (fn, event, over = {}) => fn({ business: { _id: businessId }, device, claims, event, ...over });

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(rs.getUri(), { dbName: 'offline-stock-test' });
  await Promise.all([BranchInventory, InventoryMovement, OfflineStockEvent, AuditLog].map((m) => m.init()));
  await Promise.all(['products', 'users', 'businesses'].map((c) => mongoose.connection.createCollection(c).catch(() => {}))); // collections must exist before a transaction touches them
}, 600000);
afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});


beforeEach(async () => {
  jest.restoreAllMocks();

  businessId = oid();
  otherBusinessId = oid();
  branchId = oid();
  productId = oid();
  userId = oid();
  cashierId = oid();

  device = { deviceId: 'device-0000000000001', deviceCode: 'T1', branchId };
  claims = { sub: String(userId) };

  const db = mongoose.connection.db;

  await db.collection('businesses').insertMany([
    { _id: businessId, name: 'A' },
    { _id: otherBusinessId, name: 'B' }
  ]);

  await db.collection('users').insertMany([
   {
  _id: userId,
  businessId,
  name: 'Manager',
  phone: '0700000001',
  role: 'MANAGER',
  status: 'active'
},
{
  _id: cashierId,
  businessId,
  name: 'Cashier',
  phone: '0700000002',
  role: 'CASHIER',
  status: 'active'
}
  ]);

  await db.collection('products').insertOne({
    _id: productId,
    businessId,
    name: 'Milk',
    sku: 'MLK',
    unit: 'piece',
    trackInventory: true,
    costPrice: 0,
    sellingPrice: 100,
    status: 'active'
  });
});

describe('successful events', () => {
  test('receive adds stock, writes the marker, ledger row and audit log together', async () => {
    const e = recv({ quantity: 12 });
    expect(await call(ingestStockReceive, e)).toEqual({ status: 'created' });
    expect(await qty()).toBe(12);
    expect(await OfflineStockEvent.countDocuments({ businessId, deviceId: device.deviceId, clientEventId: e.clientEventId })).toBe(1);
    expect(await InventoryMovement.countDocuments({ businessId, productId })).toBe(1);
    expect(await AuditLog.countDocuments({ businessId, action: 'inventory.receive' })).toBe(1);
  });

  test('adjust in and adjust out change stock by the right sign', async () => {
    await call(ingestStockReceive, recv({ quantity: 10 }));
    expect(await call(ingestStockAdjust, adj({ quantity: 4, adjustType: 'ADJUSTMENT_OUT' }))).toEqual({ status: 'created' });
    expect(await qty()).toBe(6);
    expect(await call(ingestStockAdjust, adj({ quantity: 2, adjustType: 'ADJUSTMENT_IN' }))).toEqual({ status: 'created' });
    expect(await qty()).toBe(8);
    expect(await AuditLog.countDocuments({ businessId, action: 'inventory.adjust' })).toBe(2);
  });
});

describe('duplicates', () => {
  test('a retry of a committed event is a duplicate and moves stock only once', async () => {
    const e = recv({ quantity: 5 });
    expect((await call(ingestStockReceive, e)).status).toBe('created');
    expect((await call(ingestStockReceive, e)).status).toBe('duplicate');
    expect(await qty()).toBe(5);
    expect(await InventoryMovement.countDocuments({ businessId, productId })).toBe(1);
  });

  test('the same clientEventId from another business or another device is NOT a duplicate', async () => {
    const e = recv({ quantity: 5 });
    await call(ingestStockReceive, e);
    const otherDevice = { ...device, deviceId: 'device-0000000000002' };
    expect((await call(ingestStockReceive, e, { device: otherDevice })).status).toBe('created');
    expect(await qty()).toBe(10);
  });

  test('concurrent submissions of the same event: exactly one commits, the rest are duplicates', async () => {
    const e = recv({ quantity: 7 });
    const results = await Promise.all(Array.from({ length: 6 }, () => call(ingestStockReceive, e).catch((err) => ({ error: err.message }))));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(5);
    expect(results.filter((r) => r.error)).toHaveLength(0);
    expect(await qty()).toBe(7);
    expect(await OfflineStockEvent.countDocuments({ businessId, clientEventId: e.clientEventId })).toBe(1);
  });
});

describe('rollback and retry', () => {
  test('a failure after the stock moved rolls back stock AND the marker', async () => {
    const e = recv({ quantity: 9 });
    jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('crash before commit')); // runs last inside receiveStock
    await expect(call(ingestStockReceive, e)).rejects.toThrow('crash before commit');
    expect(await qty()).toBe(0);
    expect(await InventoryMovement.countDocuments({ businessId, productId })).toBe(0);
    expect(await OfflineStockEvent.countDocuments({ businessId, clientEventId: e.clientEventId })).toBe(0);
  });

  test('the retry after a failed attempt is applied (not treated as a duplicate)', async () => {
    const e = recv({ quantity: 9 });
    jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('crash'));
    await expect(call(ingestStockReceive, e)).rejects.toThrow();
    jest.restoreAllMocks();
    expect((await call(ingestStockReceive, e)).status).toBe('created');
    expect(await qty()).toBe(9);
    expect((await call(ingestStockReceive, e)).status).toBe('duplicate');
    expect(await qty()).toBe(9);
  });

  test('a business-rule failure (unknown product) is a rejection and leaves no marker', async () => {
    const e = recv({ productId: oid() });
    await expect(call(ingestStockReceive, e)).rejects.toMatchObject({ isIngestRejection: true, releasable: false });
    expect(await OfflineStockEvent.countDocuments({ businessId, clientEventId: e.clientEventId })).toBe(0);
  });

  test('an unrelated duplicate-key error is surfaced, never reported as a duplicate event', async () => {
    const e = recv();
    const dup = Object.assign(new Error('E11000 duplicate key error collection: batches index: sku_1'), { code: 11000, keyPattern: { batchNumber: 1 } });
    jest.spyOn(inventoryService, 'receiveStock').mockRejectedValueOnce(dup);
    await expect(call(ingestStockReceive, e)).rejects.toBe(dup);
    expect(await OfflineStockEvent.countDocuments({ businessId, clientEventId: e.clientEventId })).toBe(0);
    expect(isMarkerDuplicate(dup)).toBe(false);
    expect(isMarkerDuplicate({ code: 11000, keyPattern: { businessId: 1, deviceId: 1, clientEventId: 1 } })).toBe(true);
  });

  test('a cashier without stock permissions cannot receive or adjust stock', async () => {
    claims = { sub: String(cashierId) };

    const receiveEvent = recv();
    await expect(call(ingestStockReceive, receiveEvent))
      .rejects.toMatchObject({ code: 'STOCK_NOT_PERMITTED' });

    const adjustEvent = adj();
    await expect(call(ingestStockAdjust, adjustEvent))
      .rejects.toMatchObject({ code: 'STOCK_NOT_PERMITTED' });

    expect(await qty()).toBe(0);
    expect(await InventoryMovement.countDocuments({ businessId })).toBe(0);
    expect(await OfflineStockEvent.countDocuments({ businessId })).toBe(0);
    expect(await AuditLog.countDocuments({ businessId })).toBe(0);
  });
});

describe('inventory.service with a caller-supplied session', () => {
  const run = async (fn) => { const s = await mongoose.startSession(); try { return await fn(s); } finally { s.endSession(); } };

  test('receiveStock / adjustStock join the caller transaction: abort rolls everything back, session stays open', async () => {
    await run(async (s) => {
      s.startTransaction();
      await inventoryService.receiveStock(businessId, branchId, userId, { productId, quantity: 5, reason: 'x', session: s });
      await inventoryService.adjustStock(businessId, branchId, userId, { productId, quantity: 2, type: 'ADJUSTMENT_OUT', reason: 'y', session: s });
      expect(s.hasEnded).toBe(false);
      expect(s.inTransaction()).toBe(true); // no nested transaction, not committed by the service
      await s.abortTransaction();
      expect(s.hasEnded).toBe(false);
    });
    expect(await qty()).toBe(0);
    expect(await AuditLog.countDocuments({ businessId })).toBe(0);
  });

  test('commit by the caller makes the whole movement visible', async () => {
    await run(async (s) => {
      await s.withTransaction(async () => {
        await inventoryService.receiveStock(businessId, branchId, userId, { productId, quantity: 5, reason: 'x', session: s });
      });
    });
    expect(await qty()).toBe(5);
  });

  test('without a session the old behaviour is unchanged (own transaction)', async () => {
    await inventoryService.receiveStock(businessId, branchId, userId, { productId, quantity: 4, reason: 'x' });
    await inventoryService.adjustStock(businessId, branchId, userId, { productId, quantity: 1, type: 'DAMAGE', reason: 'y' });
    expect(await qty()).toBe(3);
  });
});
