'use strict';
/**
 * wholesale.js - the ONE place that decides retail vs wholesale pricing.
 * Used by sale.service (online), offline-sale.service (offline sync) and the product validators/service.
 * All money is integer cents.
 *
 * RULE: a line is charged the WHOLESALE unit price when
 *   1. the business has the `wholesalePricing` feature on, AND
 *   2. the product has wholesaleEnabled with moq > 0, AND
 *   3. the TOTAL quantity of that product in the sale (all variants / repeated lines) is >= moq, AND
 *   4. an effective wholesale price exists (variant.wholesalePrice, else product.wholesalePrice) and is LOWER than
 *      the line's retail price (wholesale can never raise a price).
 * Otherwise RETAIL. A permitted manual override is applied by the caller and recorded as OVERRIDE.
 */
const PRICE_TYPES = Object.freeze({ RETAIL: 'RETAIL', WHOLESALE: 'WHOLESALE', OVERRIDE: 'OVERRIDE' });

const pos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Effective per-unit wholesale price (cents) for a product/variant, or null when none is configured. */
function effectiveWholesalePrice(product, variant) {
  if (variant && pos(variant.wholesalePrice)) return variant.wholesalePrice;
  if (product && pos(product.wholesalePrice)) return product.wholesalePrice;
  return null;
}

/**
 * @returns {{unitPrice:number, priceType:string, retailPrice:number, wholesalePrice:number|null, moq:number|null}}
 * wholesalePrice is the price that WOULD apply once the MOQ is reached (null when wholesale is not usable here).
 */
function resolveUnitPrice({ product, variant = null, wholesaleFeatureOn = false, productQuantity = 0 }) {
  const retailPrice = variant ? variant.sellingPrice : product.sellingPrice;
  const base = { unitPrice: retailPrice, priceType: PRICE_TYPES.RETAIL, retailPrice, wholesalePrice: null, moq: null };

  if (!wholesaleFeatureOn || !product.wholesaleEnabled || !pos(product.moq)) return base;
  const wp = effectiveWholesalePrice(product, variant);
  if (wp === null || wp >= retailPrice) return base;

  base.wholesalePrice = wp;
  base.moq = product.moq;
  if ((Number(productQuantity) || 0) >= product.moq) {
    base.unitPrice = wp;
    base.priceType = PRICE_TYPES.WHOLESALE;
  }
  return base;
}

/** Map<productId string, total quantity> across sale lines (items need productId + quantity). */
function sumQuantityByProduct(items) {
  const m = new Map();
  for (const it of items || []) {
    const k = String(it.productId);
    m.set(k, (m.get(k) || 0) + (Number(it.quantity) || 0));
  }
  return m;
}

/**
 * Validates a wholesale set-up. Returns [{ path:[...], message }] (empty = fine). Nothing is checked unless
 * wholesaleEnabled. Variants need { sellingPrice, wholesalePrice? }.
 */
function wholesaleConfigIssues({ wholesaleEnabled, moq, wholesalePrice, sellingPrice, hasVariants = false, variants = [] }) {
  const issues = [];
  if (!wholesaleEnabled) return issues;

  if (!pos(moq)) issues.push({ path: ['moq'], message: 'MOQ is required and must be greater than 0 when wholesale is enabled' });

  if (!hasVariants) {
    if (!pos(wholesalePrice)) {
      issues.push({ path: ['wholesalePrice'], message: 'Wholesale price is required when wholesale is enabled' });
    } else if (sellingPrice !== undefined && wholesalePrice >= sellingPrice) {
      issues.push({ path: ['wholesalePrice'], message: 'Wholesale price must be lower than the retail selling price' });
    }
    return issues;
  }

  variants.forEach((v, i) => {
    const wp = pos(v.wholesalePrice) ? v.wholesalePrice : pos(wholesalePrice) ? wholesalePrice : null;
    if (wp === null) {
      issues.push({ path: ['variants', i, 'wholesalePrice'], message: `Variant ${v.sku || i + 1}: set a wholesale price on the variant or on the product` });
    } else if (v.sellingPrice !== undefined && wp >= v.sellingPrice) {
      issues.push({ path: ['variants', i, 'wholesalePrice'], message: `Variant ${v.sku || i + 1}: wholesale price must be lower than its retail price` });
    }
  });
  return issues;
}

/**
 * Validates a WHOLESALE_FIRST product (wholesale is the default, retail is optional). All money in integer cents.
 * Stock is counted in the BASE unit; `units` are bigger/other units (factor = base units in one).
 * The wholesale unit is the unit flagged isWholesaleDefault, otherwise the base unit itself.
 * Returns [{ path:[...], message }] (empty = fine).
 */
function wholesaleFirstIssues({ retailEnabled = true, wholesalePrice, sellingPrice, units = [] }) {
  const issues = [];
  const active = (units || []).filter((u) => u.status !== 'inactive');
  const wu = active.find((u) => u.isWholesaleDefault);
  const wFactor = wu && pos(wu.factor) ? wu.factor : 1;
  const wholesaleUnitPrice = wu ? (pos(wu.wholesalePrice) ? wu.wholesalePrice : null) : (pos(wholesalePrice) ? wholesalePrice : null);

  if (wholesaleUnitPrice === null) {
    issues.push({ path: wu ? ['units'] : ['wholesalePrice'], message: 'Wholesale price is required' });
    return issues;
  }
  if (!retailEnabled) return issues;

  const floorPerBase = wholesaleUnitPrice / wFactor;
  const unitRetail = active.filter((u) => pos(u.retailPrice));
  if (!pos(sellingPrice) && !unitRetail.length) {
    issues.push({ path: ['sellingPrice'], message: 'Set a retail price (per single unit or per whole unit) or turn retail off' });
    return issues;
  }
  // 0.5 cent of tolerance: a per-base price derived from a whole-unit price is rounded to a cent.
  if (pos(sellingPrice) && sellingPrice + 0.5 < floorPerBase) {
    issues.push({ path: ['sellingPrice'], message: 'Retail price per single unit must be higher than the wholesale price per single unit' });
  }
  active.forEach((u, i) => {
    if (pos(u.retailPrice) && pos(u.wholesalePrice) && u.retailPrice <= u.wholesalePrice) {
      issues.push({ path: ['units', i, 'retailPrice'], message: `${u.name}: the retail price must be higher than its wholesale price` });
    }
  });
  return issues;
}

module.exports = { PRICE_TYPES, effectiveWholesalePrice, resolveUnitPrice, sumQuantityByProduct, wholesaleConfigIssues, wholesaleFirstIssues };
