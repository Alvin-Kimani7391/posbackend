'use strict';
/**
 * unit-conversion.service.js - dynamic unit conversion on top of the one-pool-in-base-unit stock model.
 *
 *  - getEconomics: price breakdown (cost / price / profit / margin of the base unit and every unit) + what is on hand
 *    shown in every unit (53 kg = 2 bags + 3 kg, = 106 x 500 g ...).
 *  - previewBreakdown / breakDown: turn a bag into sellable sizes with wastage and packaging cost, keeping profit exact.
 *  - listBreakdowns: history.
 *
 * Money in = integer cents (validators convert). Money out = cents here, the controller / model plugin shows KES.
 */
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Business = require('../models/Business');
const UnitConversion = require('../models/UnitConversion');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const inventoryService = require('./inventory.service');
const { resolveUnit, round3, unitEconomics, unitBreakdown, planBreakdown } = require('../utils/units');

const EPS = 0.0005;

async function loadProduct(businessId, productId, variantId) {
  const product = await Product.findOne({ _id: productId, businessId });
  if (!product) throw ApiError.notFound('Product not found');
  let variant = null;
  if (variantId) {
    variant = await ProductVariant.findOne({ _id: variantId, businessId, productId });
    if (!variant) throw ApiError.notFound('Variant not found');
  } else if (product.hasVariants) {
    throw ApiError.badRequest(`${product.name} has variants: choose a variant`, 'VARIANT_REQUIRED');
  }
  return { product, variant };
}

async function assertFeature(businessId) {
  const biz = await Business.findById(businessId).select('featureSettings').lean();
  if (!biz?.featureSettings?.unitConversions) throw ApiError.forbidden('Unit conversion is not enabled for your business', 'FEATURE_DISABLED');
}

/** Quantity in a unit -> base units. unitId empty = already base. */
function entered(product, quantity, unitId) {
  const unit = resolveUnit(product, unitId);
  return { unit, base: round3(quantity * unit.factor) };
}

/**
 * One cost per base unit is kept per product, so packaging cost (and wastage, when absorbed) is blended over
 * ALL stock that remains on hand - exactly what is saved when the break-down is confirmed.
 */
function blendedCost({ oldCost, onHand, wastageBase, extraCost, absorbWastage }) {
  const after = Math.max(onHand - wastageBase, 0);
  if (!(after > 0) || !(extraCost > 0 || (absorbWastage && wastageBase > 0))) return Math.round(oldCost);
  return Math.round((oldCost * (after + (absorbWastage ? wastageBase : 0)) + extraCost) / after);
}

/* ---------------------------------------------------------------- price breakdown */
async function getEconomics(businessId, productId, { branchId, variantId } = {}) {
  const { product, variant } = await loadProduct(businessId, productId, variantId);
  const eco = unitEconomics(product, variant);
  let stock = null;
  if (branchId) {
    const [retail, warehouse] = await Promise.all([
      inventoryService.getStockLevel(businessId, branchId, product._id, variant ? variant._id : null, 'RETAIL'),
      inventoryService.getStockLevel(businessId, branchId, product._id, variant ? variant._id : null, 'WAREHOUSE').catch(() => ({ quantity: 0 })),
    ]);
    const onHand = round3(retail.quantity || 0);
    stock = {
      retail: onHand, warehouse: round3(warehouse.quantity || 0), available: round3(retail.availableQuantity || 0),
      valueAtCostCents: Math.round(onHand * eco.costPerBaseCents),
      valueAtRetailCents: Math.round(onHand * (eco.rows[0].retailCents || 0)),
      inEveryUnit: unitBreakdown(product, onHand).map((b) => ({ ...b, unitId: String(b.unitId) })),
    };
    // projected profit if everything on hand is sold loose at the base price
    stock.potentialProfitCents = stock.valueAtRetailCents - stock.valueAtCostCents;
  }
  return {
    productId: String(product._id), variantId: variant ? String(variant._id) : null, name: product.name,
    baseUnit: eco.baseUnit, costPerBaseCents: eco.costPerBaseCents, rows: eco.rows.map((r) => ({ ...r, unitId: r.unitId ? String(r.unitId) : null })), stock,
  };
}

/* ---------------------------------------------------------------- break-down plan */
async function buildPlan(businessId, input) {
  const { productId, variantId, branchId, location = 'RETAIL', source, outputs = [], wastage, extraCost = 0, absorbWastage = false } = input;
  await assertFeature(businessId);
  const { product, variant } = await loadProduct(businessId, productId, variantId);
  if (product.trackSerialNumber) throw ApiError.badRequest(`${product.name} is serial-tracked and cannot be broken down`, 'SERIAL_BASE_ONLY');

  const src = entered(product, source.quantity, source.unitId);
  const wasteBase = wastage && wastage.quantity > 0 ? entered(product, wastage.quantity, wastage.unitId).base : 0;
  const outs = outputs.filter((o) => o.count > 0).map((o) => ({ unit: resolveUnit(product, o.unitId), count: o.count, unitId: o.unitId }));
  if (!outs.length && !(wasteBase > 0)) throw ApiError.badRequest('Add at least one size to break the stock into', 'NO_OUTPUTS');

  const cost = Number((variant ? variant.costPrice : product.costPrice) || 0);
  const plan = planBreakdown({ sourceBase: src.base, outputs: outs, wastageBase: wasteBase, extraCostCents: extraCost, costPerBaseCents: cost, absorbWastage });
  const stock = await inventoryService.getStockLevel(businessId, branchId, product._id, variant ? variant._id : null, location);
  const newCost = blendedCost({ oldCost: cost, onHand: stock.quantity || 0, wastageBase: plan.wastageBase, extraCost, absorbWastage });
  plan.newCostPerBaseCents = newCost;
  plan.lines = plan.lines.map((l) => ({ ...l, costEachCents: Math.round(newCost * l.unit.factor) }));
  const eco = unitEconomics(product, variant);
  const priceOf = (u) => (u.isBase ? eco.rows[0].retailCents : (eco.rows.find((r) => String(r.unitId) === String(u.id))?.retailCents || 0));

  const warnings = [];
  if (!plan.ok) warnings.push(`Sizes + wastage use ${round3(plan.usedBase + plan.wastageBase)} ${product.unit} but only ${plan.sourceBase} ${product.unit} is being broken`);
  if (stock.availableQuantity + EPS < plan.sourceBase) warnings.push(`Only ${round3(stock.availableQuantity)} ${product.unit} available - ${plan.sourceBase} ${product.unit} is needed`);
  const lines = plan.lines.map((l) => {
    const priceEach = priceOf(l.unit);
    const profitEach = priceEach - l.costEachCents;
    if (priceEach > 0 && profitEach < 0) warnings.push(`${l.unit.name}: sells for less than it costs after this break-down`);
    return { unitId: l.unit.id ? String(l.unit.id) : null, name: l.unit.name, factor: l.unit.factor, count: l.count, baseQuantity: l.base, costEachCents: l.costEachCents, priceEachCents: priceEach, profitEachCents: profitEach, profitTotalCents: profitEach * l.count };
  });
  return {
    product, variant, plan, lines, warnings, stock, srcUnit: src.unit, cost,
    summary: {
      baseUnit: product.unit, sourceBase: plan.sourceBase, usedBase: plan.usedBase, leftoverBase: plan.leftoverBase, wastageBase: plan.wastageBase,
      totalPieces: plan.totalPieces, costPerBaseBeforeCents: cost, costPerBaseAfterCents: plan.newCostPerBaseCents,
      wastageLossCents: plan.wastageLossCents, extraCostCents: extraCost, available: round3(stock.availableQuantity), canProceed: warnings.length === 0,
      expectedProfitCents: lines.reduce((a, l) => a + l.profitTotalCents, 0),
    },
  };
}

async function previewBreakdown(businessId, input) {
  const { lines, summary, warnings } = await buildPlan(businessId, input);
  return { lines, summary, warnings };
}

/** Execute: wastage leaves stock, packaging cost (and absorbed wastage) is folded into the weighted cost, record kept. */
async function breakDown(businessId, userId, input) {
  const built = await buildPlan(businessId, input);
  if (!built.plan.ok) throw ApiError.badRequest(built.warnings[0], 'PLAN_EXCEEDS_SOURCE');
  if (built.stock.availableQuantity + EPS < built.plan.sourceBase) throw ApiError.badRequest(built.warnings.find((w) => w.startsWith('Only')) || 'Not enough stock to break down', 'INSUFFICIENT_STOCK');
  const { product, variant, plan } = built;
  const { branchId, location = 'RETAIL', absorbWastage = false, extraCost = 0, note } = input;
  if (location === 'WAREHOUSE') await inventoryService.assertWarehouseEnabled(businessId);

  const session = await mongoose.startSession();
  try {
    let record;
    await session.withTransaction(async () => {
      // 1) wastage is the only thing that changes the quantity
      if (plan.wastageBase > 0) {
        await inventoryService.applyStockChange({
          businessId, branchId, productId: product._id, variantId: variant ? variant._id : null,
          quantityDelta: -plan.wastageBase, type: absorbWastage ? 'ADJUSTMENT_OUT' : 'DAMAGE',
          referenceType: 'UnitConversion', referenceId: null, reason: `Break-down wastage${note ? ` - ${note}` : ''}`,
          performedBy: userId, session, location, allowNegative: false,
        });
      }
      // 2) cost: blended over the stock on hand after the wastage (packaging / absorbed loss spreads over it)
      const holder = variant || product;
      const oldCost = Number(holder.costPrice || 0);
      const after = await inventoryService.getStockLevel(businessId, branchId, product._id, variant ? variant._id : null, location);
      const newCost = blendedCost({ oldCost, onHand: (after.quantity || 0) + plan.wastageBase, wastageBase: plan.wastageBase, extraCost, absorbWastage });
      if (newCost !== oldCost) { holder.costPrice = newCost; await holder.save({ session }); }

      const eco = unitEconomics(product, variant);
      [record] = await UnitConversion.create([{
        businessId, branchId, productId: product._id, variantId: variant ? variant._id : null, location,
        sourceUnitName: built.srcUnit.name, sourceQuantity: input.source.quantity, sourceBase: plan.sourceBase, baseUnitName: product.unit,
        outputs: built.lines.map((l) => ({ unitId: l.unitId || undefined, unitName: l.name, unitFactor: l.factor, count: l.count, baseQuantity: l.baseQuantity, costEach: Math.round(newCost * l.factor), priceEach: l.priceEachCents })),
        leftoverBase: plan.leftoverBase, wastageBase: plan.wastageBase, absorbWastage, wastageLoss: plan.wastageLossCents, extraCost,
        costPerBaseBefore: oldCost, costPerBaseAfter: newCost, note, createdBy: userId,
      }], { session });

      await AuditLog.create([{ businessId, branchId, userId, action: 'inventory.unit_break', entityType: 'UnitConversion', entityId: record._id, oldValue: { costPerBase: oldCost }, newValue: { sourceBase: plan.sourceBase, wastageBase: plan.wastageBase, extraCost, costPerBase: newCost } }], { session });
    });
    return { record, summary: built.summary, lines: built.lines };
  } finally {
    session.endSession();
  }
}

async function listBreakdowns(businessId, { productId, branchId, page = 1, limit = 20 } = {}) {
  const filter = { businessId };
  if (productId) filter.productId = productId;
  if (branchId) filter.branchId = branchId;
  const [items, total] = await Promise.all([
    UnitConversion.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
      .populate('productId', 'name sku unit').populate('createdBy', 'name'),
    UnitConversion.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

module.exports = { getEconomics, previewBreakdown, breakDown, listBreakdowns };
