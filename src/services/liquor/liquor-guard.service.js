/**
 * The server-side gate between a till and a bottle. createSale calls assess() BEFORE its transaction and recordWithinSale() INSIDE it,
 * so none of this can be skipped by a client:
 *   - liquor licence valid, trading hours, dry days (override needs liquor.override + a reason, and is logged)
 *   - age check on every alcoholic sale (refusals are logged too), minimum age set by the owner
 *   - optional limit on bottles per sale
 *   - returnable containers: out / back movements, and (ENFORCE) the deposit lines must match
 *   - tot lines draw from open bottles
 * Each rule has its own feature flag: liquorCompliance, ageVerification, emptiesTracking, totSales.
 */
const LiquorDetails = require('../../models/LiquorDetails');
const ContainerType = require('../../models/ContainerType');
const AgeCheckLog = require('../../models/AgeCheckLog');
const AuditLog = require('../../models/AuditLog');
const settingsSvc = require('./settings.service');
const empties = require('./empties.service');
const tots = require('./tots.service');
const { getBusinessContext } = require('../../utils/businessContext');
const { hasPermission } = require('../../utils/permissionCheck');
const ApiError = require('../../utils/ApiError');

const F = (b) => (b && b.featureSettings) || {};
const isOn = (b) => { const f = F(b); return !!(f.liquorCompliance || f.ageVerification || f.emptiesTracking || f.totSales); };

/** pure: age in whole years from a date of birth */
function ageOn(dob, at = new Date()) {
  const d = new Date(dob); if (Number.isNaN(d.getTime())) return null;
  let a = at.getUTCFullYear() - d.getUTCFullYear(); const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a -= 1; return a;
}

async function refuse({ businessId, branchId, user, check, ageYears, reason, code, message }) {
  try { await AgeCheckLog.create({ businessId, branchId, cashierId: user._id, outcome: 'REFUSED', method: check && check.dob ? 'DOB' : check && check.idType ? 'ID' : 'CONFIRMED', idType: check && check.idType, idLast4: check && check.idLast4, ageYears, reason }); } catch (e) { /* the refusal itself must still reach the cashier */ }
  throw ApiError.forbidden(message, code);
}

async function assess({ business, businessId, branchId, user, items, payload = {}, at = new Date() }) {
  if (!isOn(business)) return null;
  const f = F(business);
  const details = await LiquorDetails.find({ businessId, productId: { $in: items.map((i) => i.productId) } });
  const by = new Map(details.map((d) => [String(d.productId), d]));
  const alcoholLines = items.filter((i) => { const d = by.get(String(i.productId)); return d && d.isAlcohol; });
  const ctx = { alcohol: alcoholLines.length > 0, override: null, ageCheck: null, out: {}, returned: {}, totLines: [], branchId };
  const settings = await settingsSvc.get(businessId);
  const tz = (await getBusinessContext(businessId)).timezone;

  if (alcoholLines.length) {
    // --- licence, hours, dry days ---
    if (f.liquorCompliance) {
      const t = settingsSvc.tradingStatus(settings, tz, at);
      if (!t.open) {
        const canOverride = hasPermission(user, 'liquor.override') && t.code !== 'LICENCE_EXPIRED';
        const reason = payload.overrideReason && String(payload.overrideReason).trim();
        if (!canOverride || !reason || reason.length < 5) throw ApiError.forbidden(`${t.message}${canOverride ? ' A manager can sell anyway with a reason.' : ''}`, t.code);
        ctx.override = { code: t.code, reason, message: t.message };
      }
      if (settings.maxBottlesPerSale > 0) {
        const n = alcoholLines.reduce((s, i) => s + (i.baseQuantity || i.quantity), 0);
        if (n > settings.maxBottlesPerSale) {
          const reason = payload.overrideReason && String(payload.overrideReason).trim();
          if (!hasPermission(user, 'liquor.override') || !reason || reason.length < 5) throw ApiError.forbidden(`At most ${settings.maxBottlesPerSale} bottles of alcohol per sale. A manager can approve more with a reason.`, 'LIMIT_PER_SALE');
          ctx.override = ctx.override || { code: 'LIMIT_PER_SALE', reason, message: `${n} units` };
        }
      }
    }
    // --- age ---
    if (f.ageVerification) {
      const c = payload.ageCheck; const min = settings.age.minAge;
      if (!c) throw ApiError.badRequest('Confirm the buyer is old enough (age check) before selling alcohol', 'AGE_CHECK_REQUIRED');
      let ageYears = null; let method = 'CONFIRMED';
      if (c.dob) { ageYears = ageOn(c.dob, at); method = 'DOB'; if (ageYears === null || ageYears < 0) throw ApiError.badRequest('Invalid date of birth', 'INVALID_DOB'); }
      if (settings.age.mode === 'ID_REQUIRED' && !c.dob && !(c.idType && c.idLast4)) throw ApiError.badRequest('Check the buyer\'s ID: enter the ID type and its last 4 characters, or the date of birth', 'ID_REQUIRED');
      if (!c.dob && c.idType && c.idLast4) method = 'ID';
      if (ageYears !== null && ageYears < min) await refuse({ businessId, branchId, user, check: c, ageYears, reason: `Under ${min}`, code: 'UNDERAGE', message: `The buyer is under ${min}. Alcohol cannot be sold.` });
      if (c.looksUnderAge === true) await refuse({ businessId, branchId, user, check: c, ageYears, reason: 'Cashier refused: looked under age', code: 'UNDERAGE', message: 'Sale refused: the buyer looks under age and no valid proof was shown.' });
      if (c.confirmedOfAge !== true && ageYears === null) throw ApiError.badRequest('The cashier must confirm the buyer is of legal age', 'AGE_CHECK_REQUIRED');
      ctx.ageCheck = { method, idType: c.idType, idLast4: c.idLast4 ? String(c.idLast4).slice(-4) : undefined, ageYears };
    }
  }

  // --- returnable containers ---
  if (f.emptiesTracking && settings.emptiesMode !== 'OFF') {
    for (const i of items) { const d = by.get(String(i.productId)); if (d && d.containerTypeId && d.containersPerUnit > 0) { const k = String(d.containerTypeId); ctx.out[k] = (ctx.out[k] || 0) + Math.round((i.baseQuantity || i.quantity) * d.containersPerUnit); } }
    for (const r of payload.emptiesReturned || []) ctx.returned[String(r.containerTypeId)] = (ctx.returned[String(r.containerTypeId)] || 0) + r.quantity;
    const typeIds = [...new Set([...Object.keys(ctx.out), ...Object.keys(ctx.returned)])];
    if (typeIds.length) {
      const types = await ContainerType.find({ _id: { $in: typeIds }, businessId });
      if (types.length !== typeIds.length) throw ApiError.badRequest('Unknown container type on this sale', 'CONTAINER_NOT_FOUND');
      if (settings.emptiesMode === 'ENFORCE') {
        for (const t of types) {
          if (!t.depositProductId || !(t.deposit > 0)) continue;
          const expected = Math.max(0, (ctx.out[String(t._id)] || 0) - (ctx.returned[String(t._id)] || 0));
          const got = items.filter((i) => String(i.productId) === String(t.depositProductId)).reduce((s, i) => s + i.quantity, 0);
          if (got !== expected) throw ApiError.badRequest(`${t.name}: the deposit on this sale should be ${expected} (sold ${ctx.out[String(t._id)] || 0}, empties returned ${ctx.returned[String(t._id)] || 0}) but the cart has ${got}`, 'EMPTIES_DEPOSIT_MISMATCH');
        }
      }
    }
  }

  // --- tots ---
  if (f.totSales) {
    for (const i of items) { const d = by.get(String(i.productId)); if (d && d.tot && d.tot.bottleProductId) { const b = await LiquorDetails.findOne({ businessId, productId: d.tot.bottleProductId }); if (!b || !b.volumeMl) throw ApiError.badRequest(`${i.nameSnapshot}: the bottle's volume is not set`, 'BOTTLE_VOLUME_MISSING'); ctx.totLines.push({ item: i, bottleProductId: d.tot.bottleProductId, mlPerTot: d.tot.ml, volumeMl: b.volumeMl }); } }
  } else if (details.some((d) => d.tot && d.tot.bottleProductId)) throw ApiError.forbidden('Tot sales are not enabled for this business', 'FEATURE_DISABLED');

  return ctx;
}

async function recordWithinSale({ ctx, sale, user, customerId, session }) {
  if (!ctx) return;
  const { businessId, branchId } = sale;
  if (ctx.ageCheck) await AgeCheckLog.create([{ businessId, branchId, saleId: sale._id, cashierId: user._id, outcome: 'PASSED', method: ctx.ageCheck.method, idType: ctx.ageCheck.idType, idLast4: ctx.ageCheck.idLast4, ageYears: ctx.ageCheck.ageYears }], { session });
  if (ctx.override) await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'liquor.override', entityType: 'Sale', entityId: sale._id, newValue: ctx.override }], { session });
  if (Object.keys(ctx.out).length || Object.keys(ctx.returned).length) await empties.recordSale({ businessId, branchId, saleId: sale._id, customerId, userId: user._id, out: ctx.out, returned: ctx.returned, session });
  for (const t of ctx.totLines) await tots.draw({ businessId, branchId, saleId: sale._id, totProductId: t.item.productId, bottleProductId: t.bottleProductId, volumeMl: t.volumeMl, mlPerTot: t.mlPerTot, tots: t.item.baseQuantity || t.item.quantity, userId: user._id, receiptNumber: sale.receiptNumber, session });
}

/** cancelled sale: tots go back to the pool, container movements are reversed */
async function reverseForSale({ businessId, saleId, userId, session }) {
  await tots.reverse({ businessId, saleId, userId, session });
  await empties.reverseSale({ businessId, saleId, userId, session });
}

/** offline sales are never refused (the sale already happened); problems are flagged for review */
async function offlineFlags(business, products, { soldAt, hasAgeCheck } = {}) {
  if (!isOn(business)) return [];
  const f = F(business); const flags = [];
  const details = await LiquorDetails.find({ businessId: business._id, productId: { $in: products.map((p) => p._id) }, isAlcohol: true }).select('productId');
  if (!details.length) return flags;
  const settings = await settingsSvc.get(business._id); const tz = (await getBusinessContext(business._id)).timezone;
  if (f.liquorCompliance) { const t = settingsSvc.tradingStatus(settings, tz, soldAt ? new Date(soldAt) : new Date()); if (!t.open) flags.push({ code: `LIQUOR_${t.code}`, level: 'HIGH', message: `Alcohol sold while closed: ${t.message}` }); }
  if (f.ageVerification && !hasAgeCheck) flags.push({ code: 'LIQUOR_NO_AGE_CHECK', level: 'HIGH', message: 'Alcohol sold offline with no age check recorded.' });
  const totD = await LiquorDetails.find({ businessId: business._id, productId: { $in: products.map((p) => p._id) }, 'tot.bottleProductId': { $ne: null } }).select('_id');
  if (totD.length) flags.push({ code: 'LIQUOR_TOT_OFFLINE', level: 'WARN', message: 'Tots sold offline: the open-bottle pool was not updated. Do a dip count.' });
  return flags;
}

module.exports = { isOn, ageOn, assess, recordWithinSale, reverseForSale, offlineFlags };
