'use strict';
const crypto = require('crypto');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const Device = require('../models/Device');
const User = require('../models/User');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Category = require('../models/Category');
const Customer = require('../models/Customer');
const BranchInventory = require('../models/BranchInventory');
const Batch = require('../models/Batch');
const SerialNumber = require('../models/SerialNumber');
const CashRegister = require('../models/CashRegister');
const CashShift = require('../models/CashShift');
const IntegrationSettings = require('../models/IntegrationSettings');
const Subscription = require('../models/Subscription');
const SyncRejection = require('../models/SyncRejection');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const { getPolicy } = require('../utils/offlinePolicy');
const deviceService = require('./device.service');
const { REGISTRY, typeOf } = require('./offline-events');
const { verifyGrantForDevice, IngestRejection } = require('./offline-sale.service');

const sha1 = (v) => crypto.createHash('sha1').update(v).digest('hex');
const DURABLE = new Set(['created', 'needs_review', 'duplicate', 'held', 'rejected']); // the server now holds a durable copy
const seqOf = (x) => (x && (x.outboxSeq || x.localSeq)) || 0;

/** Keeps a durable copy of an event we could not apply. Never throws. */
async function quarantine({ businessId, device, ref, eventType, localSeq, soldAt, raw, status, code, message, releasable }) {
  try {
    await SyncRejection.findOneAndUpdate(
      { businessId, deviceId: device.deviceId, clientTransactionId: ref, status: { $in: ['HELD', 'REJECTED'] } },
      {
        $set: { branchId: device.branchId, deviceCode: device.deviceCode, eventType, localSeq, soldAt, status, code, message, releasable, payload: raw, lastReceivedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code !== 11000) console.error('[sync] quarantine write failed', err.message); // 11000 = already resolved/discarded
  }
}

async function processOne({ business, device, raw, syncedAt, skewMs }) {
  const type = typeOf(raw);
  const entry = REGISTRY[type];
  const rawRef = raw && typeof raw.clientTransactionId === 'string' ? raw.clientTransactionId.slice(0, 64)
    : raw && typeof raw.clientEventId === 'string' ? raw.clientEventId.slice(0, 64) : null;
  const parsed = entry ? entry.schema.safeParse(raw) : null;
  const data = parsed && parsed.success ? parsed.data : null;
  const ref = data ? entry.ref(data) : rawRef || `invalid-${sha1(JSON.stringify(raw || {})).slice(0, 16)}`;
  const localSeq = data ? entry.seq(data) : raw && Number.isInteger(raw.localSeq) ? raw.localSeq : undefined;
  const soldAt = data ? entry.at(data) : undefined;
  const base = { type, clientId: ref, clientTransactionId: ref, localSeq };

  const hold = async (status, code, message, releasable) => {
    await quarantine({ businessId: business._id, device, ref, eventType: REGISTRY[type] ? type : 'SALE', localSeq, soldAt, raw, status, code, message, releasable });
    return { ...base, status: status === 'HELD' ? 'held' : 'rejected', code, message };
  };

  if (!entry) return hold('REJECTED', 'UNKNOWN_EVENT_TYPE', `Unknown event type "${type}"`, false);
  if (!data) {
    const detail = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return hold('REJECTED', 'INVALID_PAYLOAD', `The data is malformed (${detail})`, false);
  }

  const discarded = await SyncRejection.findOne({ businessId: business._id, deviceId: device.deviceId, clientTransactionId: ref, status: 'DISCARDED' }).select('_id');
  if (discarded) return { ...base, status: 'rejected', code: 'DISCARDED', message: 'The business owner discarded this item' };

  if (device.status !== 'active') return hold('HELD', 'DEVICE_REVOKED', 'This device was blocked. The item is held until the owner releases or discards it.', true);

  let claims;
  try {
    claims = verifyGrantForDevice(data.grant, business._id, device);
  } catch (err) {
    if (err instanceof IngestRejection) return hold('REJECTED', err.code, err.message, err.releasable);
    throw err;
  }

  try {
    const r = await entry.run({ business, device, claims, data, syncedAt, skewMs, force: false });
    if (r.status !== 'duplicate') {
      await SyncRejection.updateOne(
        { businessId: business._id, deviceId: device.deviceId, clientTransactionId: ref, status: { $in: ['HELD', 'REJECTED'] } },
        { $set: { status: 'RELEASED', resolvedAt: new Date(), resultSaleId: r.saleId, resolutionNote: 'Accepted automatically on re-sync' } }
      );
    }
    return {
      ...base, status: r.status, saleId: r.saleId, shiftId: r.shiftId, receiptNumber: r.receiptNumber, invoiceNumber: r.invoiceNumber,
      cashDifference: r.cashDifference, flags: (r.flags || []).filter((f) => f.severity !== 'INFO').map((f) => f.code),
    };
  } catch (err) {
    if (err instanceof IngestRejection) return hold('REJECTED', err.code, err.message, err.releasable);
    console.error('[sync] unexpected ingest error', { ref, type, error: err.message });
    return { ...base, status: 'retry', code: 'SERVER_ERROR', message: 'Temporary server error. The till will retry.' };
  }
}

async function pushBatch({ businessId, user, deviceId, secret, deviceTime, pendingCount, appVersion, items }) {
  const device = await deviceService.loadDeviceWithSecret(businessId, deviceId, secret);
  if (!deviceService.userCanUseBranch(user, device.branchId)) throw ApiError.forbidden('You do not have access to this device\u2019s branch', 'BRANCH_ACCESS_DENIED');
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');

  const syncedAt = new Date();
  const skewMs = syncedAt.getTime() - deviceTime.getTime();
  const ordered = [...items].sort((a, b) => seqOf(a) - seqOf(b));

  const results = [];
  let blocked = false;
  for (const raw of ordered) {
    if (blocked) { // ORDER MATTERS (a shift close must come after its sales): once one item must be retried, nothing after it is processed
      results.push({ type: typeOf(raw), clientId: raw && (raw.clientTransactionId || raw.clientEventId), status: 'retry', code: 'BLOCKED_BY_EARLIER_ITEM', message: 'An earlier item must be retried first' });
      continue;
    }
    const r = await processOne({ business, device, raw, syncedAt, skewMs });
    if (r.status === 'retry') blocked = true;
    results.push(r);
  }

  const seqs = results.filter((r) => r.type === 'SALE' && DURABLE.has(r.status) && Number.isInteger(r.localSeq)).map((r) => r.localSeq);
  const update = { $set: { lastSyncAt: syncedAt, lastSeenAt: syncedAt } };
  if (appVersion) update.$set.appVersion = appVersion;
  if (pendingCount !== undefined) update.$set.lastPendingCount = pendingCount;
  if (seqs.length) update.$max = { highestLocalSeq: Math.max(...seqs) };
  await Device.updateOne({ _id: device._id }, update);

  const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  return { serverTime: syncedAt.toISOString(), clockSkewMs: skewMs, results, summary };
}

/* ------------------------- read side: everything a till needs offline ------------------------- */

async function assertCanPull(businessId, user, deviceId, secret) {
  const device = await deviceService.authenticateDevice(businessId, deviceId, secret);
  if (!device.offlineEnabled) throw ApiError.forbidden('Offline selling is not enabled for this device', 'OFFLINE_NOT_ENABLED_FOR_DEVICE');
  if (!deviceService.userCanUseBranch(user, device.branchId)) throw ApiError.forbidden('You do not have access to this device\u2019s branch', 'BRANCH_ACCESS_DENIED');
  const sub = await Subscription.findOne({ businessId }).select('lock').lean();
  if (sub && sub.lock && sub.lock.active) throw ApiError.forbidden('Your account is locked. Pay your balance to download catalog updates.', 'SUBSCRIPTION_LOCKED');
  return device;
}

async function getContext(businessId, user, deviceId, secret) {
  const device = await assertCanPull(businessId, user, deviceId, secret);
  const [business, branch, registers, openShift, integ, roster] = await Promise.all([
    Business.findById(businessId),
    Branch.findById(device.branchId),
    CashRegister.find({ businessId, branchId: device.branchId, status: 'active' }).select('name code').lean(),
    CashShift.findOne({ businessId, branchId: device.branchId, cashierId: user._id, status: 'OPEN' }).select('registerId openingCash openedAt clientShiftId').lean(),
    IntegrationSettings.findOne({ businessId }).select('mpesa.manualEnabled mpesa.tillNumber').lean(),
    User.find({
      businessId, status: 'active',
      $or: [{ branchIds: device.branchId }, { role: { $in: [ROLES.OWNER, ROLES.ADMIN] } }],
    }).select('name role employeeCode').lean(), // names/roles/codes only: never hashes
  ]);
  const policy = getPolicy(business);
  const rs = business.receiptSettings || {};
  const s = business.settings || {};
  const pay = business.paymentSettings || {};
  const mpesaOn = !!(integ && integ.mpesa && integ.mpesa.manualEnabled && integ.mpesa.tillNumber) && policy.allowManualMpesa;
  return {
    serverTime: new Date().toISOString(),
    business: {
      name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin, logo: business.logo,
      currency: business.currency, timezone: business.timezone,
      receiptSettings: {
        footerMessage: rs.footerMessage, headerMessage: rs.headerMessage, showLogo: rs.showLogo, showKraPin: rs.showKraPin,
        showCashierName: rs.showCashierName, showMpesaReceiptCode: rs.showMpesaReceiptCode, paperWidth: rs.paperWidth,
        customLines: rs.customLines || [], receiptPrefix: rs.receiptPrefix, invoicePrefix: rs.invoicePrefix,
      },
      taxInclusive: !!(business.taxSettings && business.taxSettings.taxInclusive),
      requireShift: !!s.requireShift,
      allowNegativeStock: !!s.allowNegativeStock,
      enableCustomerCredit: !!s.enableCustomerCredit,
      paymentMethods: { cash: pay.acceptCash !== false, mpesa: pay.acceptMpesa !== false, card: !!pay.acceptCard, bank: !!pay.acceptBank, credit: !!pay.acceptCredit },
    },
    branch: branch ? { id: branch._id, name: branch.name, code: branch.code, phone: branch.phone } : null,
    device: { deviceCode: device.deviceCode, mode: device.mode, offlineEnabled: device.offlineEnabled },
    policy,
    mpesaTill: mpesaOn ? integ.mpesa.tillNumber : null, // the Till customers pay; shown on the till screen for offline M-PESA
    registers: registers.map((r) => ({ id: String(r._id), name: r.name, code: r.code })),
    openShift: openShift ? { id: String(openShift._id), registerId: String(openShift.registerId), openingCashCents: openShift.openingCash, openedAt: openShift.openedAt, clientShiftId: openShift.clientShiftId || null } : null,
    roster: roster.map((u) => ({ id: String(u._id), name: u.name, role: u.role, employeeCode: u.employeeCode || null })),
  };
}

const mapProduct = (p) => ({
  id: String(p._id), name: p.name, sku: p.sku, barcode: p.barcode, categoryId: p.categoryId ? String(p.categoryId) : null,
  sellingPriceCents: p.sellingPrice, defaultDiscountCents: p.defaultDiscount || 0, // cost and wholesale prices are NEVER sent to a till
  taxRate: p.taxRate || 0, taxCategory: p.taxCategory, unit: p.unit, productType: p.productType,
  trackInventory: !!p.trackInventory, trackSerialNumber: !!p.trackSerialNumber, trackBatch: !!p.trackBatch, trackExpiry: !!p.trackExpiry,
  hasVariants: !!p.hasVariants, image: p.image, status: p.status, updatedAt: p.updatedAt,
});
const mapVariant = (v) => ({ id: String(v._id), productId: String(v.productId), sku: v.sku, barcode: v.barcode, attributes: v.attributes || {}, sellingPriceCents: v.sellingPrice, status: v.status, updatedAt: v.updatedAt });
const mapCategory = (c) => ({ id: String(c._id), name: c.name, parentId: c.parentId || c.parent ? String(c.parentId || c.parent) : null, status: c.status });
const mapStock = (r) => ({ id: String(r._id), productId: String(r.productId), variantId: r.variantId ? String(r.variantId) : null, quantity: r.quantity, reservedQuantity: r.reservedQuantity || 0, lowStockThreshold: r.lowStockThreshold, updatedAt: r.updatedAt });
const mapBatch = (b) => ({ id: String(b._id), productId: String(b.productId), variantId: b.variantId ? String(b.variantId) : null, batchNumber: b.batchNumber, quantity: b.quantity, expiryDate: b.expiryDate, manufacturingDate: b.manufacturingDate });
const mapSerial = (s) => ({ id: String(s._id), serialNumber: s.serialNumber, productId: s.productId ? String(s.productId) : null, variantId: s.variantId ? String(s.variantId) : null, status: s.status });
const mapCustomer = (c) => ({ id: String(c._id), name: c.name, phone: c.phone, phoneNormalized: c.phoneNormalized, creditLimitCents: c.creditLimit || 0, outstandingBalanceCents: c.outstandingBalance || 0, loyaltyPoints: c.loyaltyPoints || 0, status: c.status, updatedAt: c.updatedAt });

/**
 * key 'updatedAt' = true delta feed. key 'id' = small/static feed: the till re-downloads it whole and REPLACES its copy
 * (mode:'full'), which also removes anything deleted on the server.
 */
const FEEDS = {
  products: { model: Product, map: mapProduct, key: 'updatedAt', active: { status: 'active' } },
  variants: { model: ProductVariant, map: mapVariant, key: 'updatedAt', active: { status: 'active' } },
  stock: { model: BranchInventory, map: mapStock, key: 'updatedAt', branch: true },
  customers: { model: Customer, map: mapCustomer, key: 'updatedAt', active: { status: 'active' }, needs: 'syncCustomers' },
  categories: { model: Category, map: mapCategory, key: 'id' },
  batches: { model: Batch, map: mapBatch, key: 'id', branch: true, active: { quantity: { $gt: 0 } } },
  serials: { model: SerialNumber, map: mapSerial, key: 'id', active: { status: 'in_stock' } },
};

async function getCatalogPage(businessId, user, { deviceId, secret, type, cursor, since, limit }) {
  const device = await assertCanPull(businessId, user, deviceId, secret);
  const feed = FEEDS[type];
  if (feed.needs) {
    const business = await Business.findById(businessId).select('settings');
    if (!getPolicy(business)[feed.needs]) throw ApiError.forbidden('Customer data is not enabled for tills in this business', 'CUSTOMERS_NOT_SYNCED');
  }

  const q = { businessId };
  if (feed.branch) q.branchId = device.branchId;
  let effective = cursor;
  if (!effective && since && feed.key === 'updatedAt') effective = `${since.toISOString()}|000000000000000000000000`;

  let sort;
  if (feed.key === 'updatedAt') {
    sort = { updatedAt: 1, _id: 1 };
    if (effective) {
      const [iso, id] = effective.split('|');
      const d = new Date(iso);
      if (Number.isNaN(d.getTime()) || !/^[a-f0-9]{24}$/i.test(id || '')) throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
      q.$or = [{ updatedAt: { $gt: d } }, { updatedAt: d, _id: { $gt: id } }];
    } else if (feed.active) Object.assign(q, feed.active);
  } else {
    sort = { _id: 1 };
    if (feed.active) Object.assign(q, feed.active);
    if (effective) {
      const id = effective.split('|')[1] || '';
      if (!/^[a-f0-9]{24}$/i.test(id)) throw ApiError.badRequest('Invalid cursor', 'INVALID_CURSOR');
      q._id = { $gt: id };
    }
  }

  const rows = await feed.model.find(q).sort(sort).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const stamp = last && feed.key === 'updatedAt' ? new Date(last.updatedAt).toISOString() : '0';
  return {
    type, mode: feed.key === 'id' || !effective ? 'full' : 'delta',
    items: page.map(feed.map), hasMore,
    nextCursor: last ? `${stamp}|${last._id}` : effective || null,
    serverTime: new Date().toISOString(),
  };
}

/** Lets the till prune items hard-deleted on the server (a delta feed cannot show deletions). */
async function getCatalogIds(businessId, user, deviceId, secret) {
  await assertCanPull(businessId, user, deviceId, secret);
  const [products, variants] = await Promise.all([
    Product.find({ businessId, status: 'active' }).select('_id').limit(100000).lean(),
    ProductVariant.find({ businessId, status: 'active' }).select('_id').limit(100000).lean(),
  ]);
  return { productIds: products.map((p) => String(p._id)), variantIds: variants.map((v) => String(v._id)), serverTime: new Date().toISOString() };
}

module.exports = { pushBatch, getContext, getCatalogPage, getCatalogIds };