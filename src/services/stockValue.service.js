/**
 * Single source of truth for "what is my stock worth?".
 * Used by the dashboard / reports (report.service#getInventoryReport) AND by
 * Shop -> Stock valuation (shop/shop-report.service#stockValuation), so both
 * screens always show the same figure.
 *
 * Rules (all money in integer cents):
 *  1. Only quantities > 0 count; negative stock is never netted off the total.
 *  2. Products with trackInventory=false are ignored.
 *  3. Unit cost, in order: the batch's own cost (real cost of that delivery) ->
 *     variant cost -> product cost.  Stock not sitting in a batch (legacy /
 *     non-batch products) uses variant cost -> product cost.
 *  4. Active batches already past their expiry date are NOT counted in the
 *     stock value; they are reported separately as expiredCost.
 *  5. Warehouse stock (WarehouseInventory) is included and also shown on its own.
 *  6. Items valued at a zero cost are counted/listed (zeroCostItems) so a
 *     missing cost price is visible instead of silently valuing stock at 0.
 */
const mongoose = require('mongoose');
const BranchInventory = require('../models/BranchInventory');
const WarehouseInventory = require('../models/WarehouseInventory');
const Batch = require('../models/Batch');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');

const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const bKey = (branchId, productId, variantId) => `${branchId}:${productId}:${variantId || ''}`;

async function computeStockValue(businessId, { branchId, includeWarehouse = true } = {}) {
  const biz = oid(businessId);
  const invMatch = { businessId: biz, quantity: { $gt: 0 } };
  if (branchId) invMatch.branchId = oid(branchId);

  const [retailRows, whRows] = await Promise.all([
    BranchInventory.find(invMatch).select('branchId productId variantId quantity').lean(),
    includeWarehouse
      ? WarehouseInventory.find(invMatch).select('branchId productId variantId quantity').lean()
      : Promise.resolve([]),
  ]);

  const productIds = [...new Set([...retailRows, ...whRows].map((r) => String(r.productId)))];
  const variantIds = [...new Set([...retailRows, ...whRows].filter((r) => r.variantId).map((r) => String(r.variantId)))];

  const batchMatch = { businessId: biz, status: 'active', quantity: { $gt: 0 }, productId: { $in: productIds.map(oid) } };
  if (branchId) batchMatch.branchId = oid(branchId);

  const [products, variants, batches] = await Promise.all([
    Product.find({ _id: { $in: productIds.map(oid) }, businessId: biz }).select('name categoryId costPrice sellingPrice trackInventory').lean(),
    variantIds.length ? ProductVariant.find({ _id: { $in: variantIds.map(oid) }, businessId: biz }).select('costPrice sellingPrice').lean() : [],
    productIds.length ? Batch.find(batchMatch).select('branchId productId variantId location quantity costPrice expiryDate').lean() : [],
  ]);

  const P = new Map(products.map((p) => [String(p._id), p]));
  const V = new Map(variants.map((v) => [String(v._id), v]));
  const batchesBy = new Map(); // `${location}|branch:product:variant` -> batches
  for (const b of batches) {
    const k = `${b.location || 'RETAIL'}|${bKey(b.branchId, b.productId, b.variantId)}`;
    if (!batchesBy.has(k)) batchesBy.set(k, []);
    batchesBy.get(k).push(b);
  }

  const now = new Date();
  const items = new Map(); // productId -> aggregate
  const totals = { units: 0, cost: 0, retail: 0, retailCost: 0, warehouseUnits: 0, warehouseCost: 0, expiredUnits: 0, expiredCost: 0, zeroCostItems: 0, zeroCostUnits: 0 };
  const zeroCostList = [];

  const addPool = (rows, location) => {
    for (const r of rows) {
      const product = P.get(String(r.productId));
      if (!product || product.trackInventory === false) continue;
      const variant = r.variantId ? V.get(String(r.variantId)) : null;
      const fallbackCost = (variant && variant.costPrice) || product.costPrice || 0;
      const sellPrice = (variant && variant.sellingPrice) || product.sellingPrice || 0;

      let remaining = r.quantity;
      let sellableUnits = 0; let sellableCost = 0; let expiredUnits = 0; let expiredCost = 0; let zeroUnits = 0;

      const list = (batchesBy.get(`${location}|${bKey(r.branchId, r.productId, r.variantId)}`) || [])
        .slice().sort((a, b) => (a.expiryDate || 8.64e15) - (b.expiryDate || 8.64e15));
      for (const b of list) {
        if (remaining <= 0) break;
        const take = Math.min(b.quantity, remaining);
        const unitCost = b.costPrice || fallbackCost;
        remaining -= take;
        if (b.expiryDate && new Date(b.expiryDate) < now) { expiredUnits += take; expiredCost += take * unitCost; continue; }
        sellableUnits += take; sellableCost += take * unitCost;
        if (!unitCost) zeroUnits += take;
      }
      if (remaining > 0) { // stock not held in a batch
        sellableUnits += remaining; sellableCost += remaining * fallbackCost;
        if (!fallbackCost) zeroUnits += remaining;
      }

      const k = String(r.productId);
      const it = items.get(k) || { productId: product._id, categoryId: product.categoryId || null, name: product.name, units: 0, cost: 0, retail: 0, warehouseUnits: 0, warehouseCost: 0, expiredUnits: 0, expiredCost: 0, zeroCostUnits: 0 };
      it.expiredUnits += expiredUnits; it.expiredCost += expiredCost; it.zeroCostUnits += zeroUnits;
      if (location === 'WAREHOUSE') { it.warehouseUnits += sellableUnits; it.warehouseCost += sellableCost; totals.warehouseUnits += sellableUnits; totals.warehouseCost += sellableCost; }
      else { it.units += sellableUnits; it.cost += sellableCost; it.retail += sellableUnits * sellPrice; totals.retailCost += sellableCost; }
      totals.units += sellableUnits; totals.cost += sellableCost; totals.retail += sellableUnits * sellPrice;
      totals.expiredUnits += expiredUnits; totals.expiredCost += expiredCost; totals.zeroCostUnits += zeroUnits;
      items.set(k, it);
    }
  };
  addPool(retailRows, 'RETAIL');
  addPool(whRows, 'WAREHOUSE');

  for (const it of items.values()) {
    if (it.zeroCostUnits > 0) { totals.zeroCostItems += 1; zeroCostList.push({ productId: it.productId, name: it.name, units: it.zeroCostUnits }); }
  }
  for (const k of ['cost', 'retail', 'retailCost', 'warehouseCost', 'expiredCost']) totals[k] = Math.round(totals[k]);
  const list = [...items.values()].map((i) => ({ ...i, cost: Math.round(i.cost), retail: Math.round(i.retail), warehouseCost: Math.round(i.warehouseCost), expiredCost: Math.round(i.expiredCost) }));
  zeroCostList.sort((a, b) => b.units - a.units);
  return { items: list, totals, zeroCostList: zeroCostList.slice(0, 20) };
}

module.exports = { computeStockValue };
