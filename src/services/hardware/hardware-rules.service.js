/** Hardware rules applied to every sale line inside createSale: fractional quantities, divisibility, contractor prices and quantity breaks. Null / no-op outside hardware shops. Money = integer cents. */
const HardwareProfile = require('../../models/HardwareProfile');
const ContractorPrice = require('../../models/ContractorPrice');
const ApiError = require('../../utils/ApiError');

const active = (u) => u.status !== 'inactive';
const inWindow = (r, now) => (!r.validFrom || r.validFrom <= now) && (!r.validTo || r.validTo >= now);

/** pure: refuse quantities the product cannot be sold in */
function checkQuantity({ profile, product, unit, quantity }) {
  if (!profile) return;
  if (!profile.measurable && !Number.isInteger(quantity)) throw ApiError.badRequest(`${product.name} is sold in whole ${unit.name}s only`, 'WHOLE_QUANTITY_ONLY');
  const bigger = (product.units || []).filter(active);
  if (profile.divisible === false && unit.isBase && bigger.length) throw ApiError.badRequest(`${product.name} is not sold loose. Sell it by ${bigger.map((u) => u.name).join(' or ')}.`, 'NOT_DIVISIBLE');
}

/** pure: the lowest of the standard price, a quantity break and any contractor price (never below cost). Returns null when nothing beats the standard price. */
function bestPrice({ current, factor, baseQty, costPerBase = 0, listPerBase = 0, breaks = [], contractor = [], now = new Date() }) {
  const cands = [];
  const brk = breaks.filter((b) => b.minQty <= baseQty).sort((a, b) => b.minQty - a.minQty)[0];
  if (brk) cands.push(Math.round(brk.unitPrice * factor));
  for (const r of contractor) {
    if (!inWindow(r, now) || (r.minQty || 0) > baseQty) continue;
    const perBase = r.mode === 'FIXED' ? r.value : r.mode === 'PERCENT_OFF' ? listPerBase * (1 - r.value / 100) : costPerBase * (1 + r.value / 100);
    cands.push(Math.round(perBase * factor));
  }
  if (!cands.length) return null;
  const floor = Math.round(costPerBase * factor);
  const best = Math.max(Math.min(...cands), floor);
  return best < current ? best : null;
}

async function lineRules({ business, businessId, customer, product, variant, unit, quantity, baseQuantity, unitPrice, channel }) {
  const f = business.featureSettings || {};
  if (business.businessType !== 'hardware' && !f.contractorPricing) return null;
  const profile = await HardwareProfile.findOne({ businessId, productId: product._id }).lean();
  checkQuantity({ profile, product, unit, quantity });
  if (profile?.lifecycle === 'UNAVAILABLE') throw ApiError.badRequest(`${product.name} is temporarily unavailable`, 'PRODUCT_UNAVAILABLE');
  if (!f.contractorPricing || channel === 'WHOLESALE') return null;
  const contractor = customer ? await ContractorPrice.find({ businessId, customerId: customer._id, active: true, $or: [{ productId: product._id }, ...(product.categoryId ? [{ categoryId: product.categoryId }] : [])] }).lean() : [];
  const best = bestPrice({ current: unitPrice, factor: unit.factor, baseQty: baseQuantity, costPerBase: variant ? variant.costPrice : product.costPrice, listPerBase: variant ? variant.sellingPrice : product.sellingPrice, breaks: profile?.breaks || [], contractor });
  return best === null ? null : { unitPrice: best, priceType: 'CONTRACT' };
}

module.exports = { checkQuantity, bestPrice, lineRules };
