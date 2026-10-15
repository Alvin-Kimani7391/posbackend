const mongoose = require('mongoose');
const Warehouse = require('../models/Warehouse');
const WarehouseInventory = require('../models/WarehouseInventory');
const ApiError = require('../utils/ApiError');
const { nextSequence } = require('../models/Counter');

/**
 * Finding (and, the first time, creating) warehouses. No other service is required here, so inventory.service,
 * warehouse.service, sale.service etc. can all use it without circular requires.
 * A branch always ends up with ONE default warehouse: the first time warehouse stock is touched for a branch that has
 * none, "Main Warehouse" is created and older warehouse rows (written before multi-warehouse, no warehouseId) are
 * attached to it. scripts/migrate-multi-warehouse.js does the same for every branch at once.
 */
const withSession = (q, session) => (session ? q.session(session) : q);

async function nextWarehouseCode(businessId, session) {
  const seq = await nextSequence(businessId, 'warehouse:business', session);
  return `WH-${String(seq).padStart(3, '0')}`;
}

async function adoptLegacyRows(businessId, branchId, warehouseId, session) {
  await WarehouseInventory.updateMany({ businessId, branchId, warehouseId: { $in: [null] } }, { $set: { warehouseId } }, session ? { session } : {});
}

async function ensureDefaultWarehouse(businessId, branchId, userId, session) {
  let wh = await withSession(Warehouse.findOne({ businessId, branchId, isDefault: true, status: 'active' }), session);
  if (wh) return wh;
  // another (inactive) default? then promote any active warehouse of the branch before creating one
  wh = await withSession(Warehouse.findOne({ businessId, branchId, status: 'active' }).sort({ createdAt: 1 }), session);
  if (wh) {
    await Warehouse.updateMany({ businessId, branchId, isDefault: true }, { $set: { isDefault: false } }, session ? { session } : {});
    wh.isDefault = true;
    await wh.save(session ? { session } : {});
    return wh;
  }
  const code = await nextWarehouseCode(businessId, session);
  try {
    const [created] = await Warehouse.create([{ businessId, branchId, name: 'Main Warehouse', code, isDefault: true, createdBy: userId }], session ? { session } : {});
    await adoptLegacyRows(businessId, branchId, created._id, session);
    return created;
  } catch (err) {
    if (err.code === 11000) return withSession(Warehouse.findOne({ businessId, branchId, isDefault: true }), session);
    throw err;
  }
}

/**
 * resolveWarehouse(businessId, { warehouseId?, branchId?, userId?, session?, forSale? })
 * - warehouseId given: must belong to the business and be active (forSale: also allowSales).
 * - otherwise the default warehouse of branchId (created on first use).
 */
async function resolveWarehouse(businessId, { warehouseId, branchId, userId, session, forSale = false } = {}) {
  let wh;
  if (warehouseId) {
    wh = await withSession(Warehouse.findOne({ _id: warehouseId, businessId }), session);
    if (!wh) throw ApiError.badRequest('Warehouse not found', 'WAREHOUSE_NOT_FOUND');
  } else {
    if (!branchId) throw ApiError.badRequest('Give a warehouseId or a branchId', 'WAREHOUSE_REQUIRED');
    wh = await ensureDefaultWarehouse(businessId, branchId, userId, session);
  }
  if (wh.status !== 'active') throw ApiError.badRequest(`Warehouse ${wh.name} is inactive`, 'WAREHOUSE_INACTIVE');
  if (forSale && !wh.allowSales) throw ApiError.badRequest(`Warehouse ${wh.name} is storage only (sales are switched off for it)`, 'WAREHOUSE_NO_SALES');
  return wh;
}

/** Where a completed sale's stock came from: { location, warehouseId, branchId } (used by cancel and refund). */
async function saleStockTarget(businessId, sale, session) {
  if (sale.channel !== 'WHOLESALE') return { location: 'RETAIL', warehouseId: null, branchId: sale.branchId };
  const wh = sale.warehouseId ? await withSession(Warehouse.findOne({ _id: sale.warehouseId, businessId }), session) : null;
  return { location: 'WAREHOUSE', warehouseId: wh?._id || sale.warehouseId || null, branchId: wh?.branchId || sale.branchId };
}

module.exports = { resolveWarehouse, ensureDefaultWarehouse, saleStockTarget, nextWarehouseCode };
