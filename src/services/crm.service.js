const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const CustomerPurchase = require('../models/CustomerPurchase');
const CustomerSegment = require('../models/CustomerSegment');
const CrmSettings = require('../models/CrmSettings');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const Category = require('../models/Category');
const MpesaTransaction = require('../models/MpesaTransaction');
const MpesaInboundPayment = require('../models/MpesaInboundPayment');
const ApiError = require('../utils/ApiError');
const { normalizePhone, toLocalPhone } = require('../utils/phone');
const engine = require('./crm.engine');

// Refund is optional here: if the model is missing/renamed the CRM still works
// (refunds are then taken from Sale.items[].refundedQuantity alone).
let Refund = null;
try { Refund = require('../models/Refund'); } catch (e) { Refund = null; }

const { DAY } = engine;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const TZ = 'Africa/Nairobi';

/* ==========================================================================
   FIELD ADAPTERS - the ONLY place that knows how your Sale / Refund documents
   are shaped. If a field name differs in your schema, change it here.
   All amounts are read as raw integer cents (we query with .lean()).
   ========================================================================== */
const SALE_EXCLUDED = ['DRAFT', 'HELD', 'PENDING', 'VOIDED', 'VOID', 'CANCELLED', 'CANCELED'];
const saleStatus = (s) => String(s.saleStatus || s.status || '').toUpperCase();
const saleTotal = (s) => Number(s.grandTotal ?? s.totalAmount ?? s.total ?? 0) || 0;
const saleAt = (s) => s.completedAt || s.soldAt || s.createdAt;
const saleNo = (s) => s.saleNumber || s.receiptNumber || s.invoiceNumber || s.number || undefined;
const saleItems = (s) => s.items || s.lines || [];
const itemProductId = (i) => i.productId || i.product;
const itemAmount = (i) =>
  Number(i.lineTotal ?? i.total ?? i.subtotal ?? (Number(i.unitPrice ?? i.price ?? 0) * Number(i.quantity ?? i.qty ?? 1))) || 0;
const itemQty = (i) => Number(i.quantity ?? i.qty ?? 1) || 1;
const refundAmount = (r) => Number(r.totalAmount ?? r.amount ?? r.total ?? 0) || 0;
const REFUND_NOT_COUNTED = ['PENDING', 'PENDING_APPROVAL', 'REJECTED', 'DECLINED', 'CANCELLED', 'CANCELED'];

/** Refunded value implied by the sale's own line items (refundedQuantity / quantity x line total). */
function refundFromItems(sale) {
  return saleItems(sale).reduce((sum, i) => {
    const rq = Number(i.refundedQuantity || 0);
    if (rq <= 0) return sum;
    return sum + Math.round(itemAmount(i) * Math.min(rq / itemQty(i), 1));
  }, 0);
}

/* ------------------------------- settings ------------------------------- */
const settingsCache = new Map();

async function getSettings(businessId) {
  const key = String(businessId);
  const hit = settingsCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.value;
  let doc;
  try {
    doc = await CrmSettings.findOneAndUpdate(
      { businessId },
      { $setOnInsert: { businessId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (e) {
    doc = await CrmSettings.findOne({ businessId }).lean();
  }
  if (!doc) throw new Error('CRM settings could not be loaded');
  settingsCache.set(key, { at: Date.now(), value: doc });
  return doc;
}

async function updateSettings(businessId, patch) {
  const clean = {};
  ['newWindowDays', 'inactiveDays', 'frequentMinPurchases', 'frequentWindowDays', 'vipMinPurchases'].forEach((k) => {
    if (patch[k] !== undefined) clean[k] = Math.round(Number(patch[k]));
  });
  if (patch.vipMinSpend !== undefined) clean.vipMinSpendCents = Math.round(Number(patch.vipMinSpend) * 100);
  await getSettings(businessId);
  await CrmSettings.updateOne({ businessId }, { $set: clean });
  settingsCache.delete(String(businessId));
  // thresholds changed => every label may change; refresh in the background
  setImmediate(() => refreshLifecycles(businessId).catch((e) => console.error('[crm] refresh failed', e)));
  return getSettings(businessId);
}

/* ------------------------- customer capture by phone ------------------------- */
const isDup = (e) => e && (e.code === 11000 || e.statusCode === 409);

/** Matches "0712345678", "+254 712 345 678", "0712-345-678", "712345678" ... for the same 9 digits. */
function legacyPhoneRegex(phoneNorm) {
  const body = phoneNorm.slice(-9).split('').join('[\\s.\\-]*');
  return new RegExp(`^\\s*(?:\\+?254|0)?[\\s.\\-]*${body}\\s*$`);
}

/**
 * Finds the customer who owns this phone. Customers created BEFORE the CRM existed have a `phone`
 * but no `phoneNormalized`, so a normalised-only lookup would miss them and create a duplicate;
 * we fall back to a format-tolerant match and stamp phoneNormalized on the hit.
 */
async function findCustomerByPhone(businessId, phoneNorm) {
  const hit = await Customer.findOne({ businessId, phoneNormalized: phoneNorm }).select('_id').lean();
  if (hit) return hit._id;

  const legacy = await Customer.findOne({ businessId, phoneNormalized: { $exists: false }, phone: legacyPhoneRegex(phoneNorm) })
    .sort({ createdAt: 1 }).select('_id').lean();
  if (!legacy) return null;
  try {
    await Customer.updateOne({ _id: legacy._id }, { $set: { phoneNormalized: phoneNorm } }, { timestamps: false });
  } catch (e) {
    if (!isDup(e)) console.error('[crm] could not stamp phoneNormalized', e.message);
  }
  return legacy._id;
}

/**
 * Returns the customer id for this phone, creating the customer if needed.
 * NOTE the second attempt: the original Customer index { businessId, customerNumber } is
 * `unique + sparse`, but a COMPOUND sparse index still indexes documents that lack customerNumber
 * (businessId is present), so a second customer without a number is rejected with E11000.
 * Auto-captured customers have no number, so on that specific error we retry with a generated one.
 */
async function ensureCustomerByPhone(businessId, phoneNorm, { name, source = 'mpesa' } = {}) {
  const existing = await findCustomerByPhone(businessId, phoneNorm);
  if (existing) return existing;

  const local = toLocalPhone(phoneNorm);
  const doc = { businessId, name: (name && String(name).trim()) || local, phone: local, source };
  const attempts = [doc, { ...doc, customerNumber: `AUTO-${phoneNorm.slice(-9)}` }];

  let lastErr;
  for (const d of attempts) {
    try {
      const created = await Customer.create(d);
      return created._id;
    } catch (e) {
      lastErr = e;
      if (isDup(e)) {
        const again = await findCustomerByPhone(businessId, phoneNorm); // lost a race: someone just created them
        if (again) return again;
      }
      const numberCollision = e && e.code === 11000 && /customerNumber/.test(String(e.message));
      if (!numberCollision) throw e;
    }
  }
  throw lastErr;
}

/** A cashier picked a customer who has no phone, and the payer's phone is known: remember it (never overrides). */
async function fillMissingPhone(businessId, customerId, phoneNorm) {
  try {
    if (await Customer.exists({ businessId, phoneNormalized: phoneNorm })) return;
    await Customer.updateOne(
      { _id: customerId, businessId, $or: [{ phone: { $exists: false } }, { phone: '' }, { phone: null }] },
      { $set: { phone: toLocalPhone(phoneNorm), phoneNormalized: phoneNorm } },
      { timestamps: false }
    );
  } catch (e) {
    console.error('[crm] could not add phone to customer', e.message);
  }
}

/** saleId -> { phone, name, receipt } for sales settled through a successful M-PESA payment */
async function loadMpesaContext(businessId, saleIds) {
  const out = new Map();
  if (!saleIds.length) return out;
  const txns = await MpesaTransaction.find({ businessId, saleId: { $in: saleIds }, status: 'SUCCESS' })
    .select('saleId phone mpesaReceiptNumber matchedInboundId')
    .lean();
  const inboundIds = txns.map((t) => t.matchedInboundId).filter(Boolean);
  const inbound = inboundIds.length
    ? await MpesaInboundPayment.find({ _id: { $in: inboundIds } }).select('payerPhone payerName').lean()
    : [];
  const inboundById = new Map(inbound.map((i) => [String(i._id), i]));
  txns.forEach((t) => {
    const ib = t.matchedInboundId ? inboundById.get(String(t.matchedInboundId)) : null;
    const phone = normalizePhone(t.phone) || normalizePhone(ib && ib.payerPhone);
    out.set(String(t.saleId), { phone, name: ib && ib.payerName, receipt: t.mpesaReceiptNumber });
  });
  return out;
}

/* ------------------------------ sale -> purchase ------------------------------ */
async function syncSaleBatch(businessId, sales, settings) {
  const result = { linked: 0, skipped: 0, errors: [] };
  if (!sales.length) return result;
  const saleIds = sales.map((s) => s._id);

  const [existing, pays, refunds, mpesa] = await Promise.all([
    CustomerPurchase.find({ businessId, saleId: { $in: saleIds } }).select('saleId customerId').lean(),
    Payment.find({ businessId, saleId: { $in: saleIds } }).select('saleId method').lean(),
    Refund
      ? Refund.find({ businessId, saleId: { $in: saleIds }, status: { $nin: REFUND_NOT_COUNTED } }).lean().catch(() => [])
      : Promise.resolve([]),
    loadMpesaContext(businessId, saleIds),
  ]);
  const existingBySale = new Map(existing.map((e) => [String(e.saleId), e]));

  const methodsBySale = new Map();
  pays.forEach((p) => {
    const k = String(p.saleId);
    if (!methodsBySale.has(k)) methodsBySale.set(k, new Set());
    if (p.method) methodsBySale.get(k).add(String(p.method).toUpperCase());
  });
  const refundBySale = new Map();
  refunds.forEach((r) => {
    const k = String(r.saleId);
    refundBySale.set(k, (refundBySale.get(k) || 0) + refundAmount(r));
  });

  // product -> category name (one batched lookup for the whole page of sales)
  const productIds = new Set();
  sales.forEach((s) => saleItems(s).forEach((i) => { const p = itemProductId(i); if (p) productIds.add(String(p)); }));
  const catByProduct = new Map();
  if (productIds.size) {
    try {
      const products = await Product.find({ _id: { $in: [...productIds] } }).select('categoryId category').lean();
      const catIds = [...new Set(products.map((p) => String(p.categoryId || p.category || '')).filter(Boolean))];
      const cats = catIds.length ? await Category.find({ _id: { $in: catIds } }).select('name').lean() : [];
      const catName = new Map(cats.map((c) => [String(c._id), c.name]));
      products.forEach((p) => catByProduct.set(String(p._id), catName.get(String(p.categoryId || p.category || '')) || 'Uncategorised'));
    } catch (e) {
      // categories are a nice-to-have: never let them block capturing the customer
      console.error('[crm] category lookup failed (continuing as Uncategorised)', e.message);
    }
  }

  const affected = new Set();
  const ops = [];

  for (const s of sales) {
    const sid = String(s._id);
    try {
      const prior = existingBySale.get(sid);
      const excluded = SALE_EXCLUDED.includes(saleStatus(s));
      if (excluded && !prior) { result.skipped += 1; continue; }

      // who bought?
      let customerId = s.customerId || (prior && prior.customerId) || null;
      const mp = mpesa.get(sid);
      let linkedBy = 'sale';
      if (!s.customerId && mp && mp.phone) {
        customerId = await ensureCustomerByPhone(businessId, mp.phone, { name: mp.name, source: 'mpesa' });
        linkedBy = 'mpesa';
      } else if (s.customerId && mp && mp.phone) {
        await fillMissingPhone(businessId, s.customerId, mp.phone);
      }
      if (!customerId) { result.skipped += 1; continue; }

      if (prior && String(prior.customerId) !== String(customerId)) affected.add(String(prior.customerId));
      affected.add(String(customerId));

      const catAgg = new Map();
      let itemCount = 0;
      saleItems(s).forEach((i) => {
        const cat = catByProduct.get(String(itemProductId(i))) || 'Uncategorised';
        catAgg.set(cat, (catAgg.get(cat) || 0) + itemAmount(i));
        itemCount += itemQty(i);
      });

      const methods = [...(methodsBySale.get(sid) || [])];
      if (mp && !methods.includes('MPESA')) methods.push('MPESA');

      const total = saleTotal(s);
      // Refund docs and the sale's own refundedQuantity can both describe the same refund; take the larger, never more than the sale.
      const refunded = Math.min(Math.max(refundBySale.get(sid) || 0, refundFromItems(s)), total);

      ops.push({
        updateOne: {
          filter: { businessId, saleId: s._id },
          update: {
            $set: {
              businessId,
              customerId,
              saleId: s._id,
              branchId: s.branchId,
              saleNumber: saleNo(s),
              amountCents: total,
              refundedCents: refunded,
              itemCount,
              categories: [...catAgg].map(([name, amountCents]) => ({ name, amountCents })),
              paymentMethods: methods,
              mpesaReceipt: mp && mp.receipt,
              linkedBy,
              purchasedAt: saleAt(s),
              voided: excluded,
            },
          },
          upsert: true,
        },
      });
      result.linked += 1;
    } catch (e) {
      // one bad sale must not stop the rest of the batch, and must never be silent
      console.error('[crm] sale capture failed', sid, e.stack || e.message);
      result.errors.push(`${sid}: ${e.message}`);
    }
  }

  if (ops.length) await CustomerPurchase.bulkWrite(ops, { ordered: false });
  if (affected.size) await recomputeCustomers(businessId, [...affected], settings);
  return result;
}

/**
 * Hook: called (fire-and-forget) right after a sale is saved - from sale.service.createSale after
 * the transaction commits, and from the MpesaTransaction model when a payment is attached to a sale.
 * Never throws into the caller. Retries a few times (sale not visible yet / transient error) and
 * ignores a second call for the same sale within a minute (both hooks may fire).
 */
const lastCapture = new Map();
function onSaleCompleted(businessId, saleId, attempt = 0) {
  const key = String(saleId);
  if (attempt === 0) {
    const now = Date.now();
    if (now - (lastCapture.get(key) || 0) < 60 * 1000) return;
    lastCapture.set(key, now);
    if (lastCapture.size > 2000) {
      for (const [k, at] of lastCapture) if (now - at > 5 * 60 * 1000) lastCapture.delete(k);
    }
  }
  const delays = [1500, 10000, 30000, 90000];
  const t = setTimeout(async () => {
    try {
      const settings = await getSettings(businessId);
      const sale = await Sale.findOne({ _id: saleId, businessId }).lean();
      if (!sale) throw new Error('sale not visible yet');
      const r = await syncSaleBatch(businessId, [sale], settings);
      if (r.errors.length) throw new Error(r.errors[0]);
      console.log('[crm] captured sale', key, JSON.stringify({ linked: r.linked, skipped: r.skipped }));
    } catch (e) {
      console.error('[crm] capture attempt', attempt, 'failed', key, e.stack || e.message);
      if (attempt < delays.length - 1) onSaleCompleted(businessId, saleId, attempt + 1);
    }
  }, delays[attempt]);
  if (t.unref) t.unref();
}

/**
 * Hook: an M-PESA STK payment just turned SUCCESS. Capture the payer's phone right away, even
 * before the cashier finishes saving the sale (the purchase itself is linked later by onSaleCompleted).
 */
function onPaymentSucceeded(businessId, txnId) {
  setImmediate(async () => {
    try {
      const txn = await MpesaTransaction.findOne({ _id: txnId, businessId }).select('phone status matchedInboundId').lean();
      if (!txn || txn.status !== 'SUCCESS') return;
      let phone = normalizePhone(txn.phone);
      let name;
      if (txn.matchedInboundId) {
        const ib = await MpesaInboundPayment.findById(txn.matchedInboundId).select('payerPhone payerName').lean();
        phone = phone || normalizePhone(ib && ib.payerPhone);
        name = ib && ib.payerName;
      }
      if (!phone) return;
      await ensureCustomerByPhone(businessId, phone, { name, source: 'mpesa' });
    } catch (e) {
      console.error('[crm] payment capture failed', String(txnId), e.stack || e.message);
    }
  });
}

/** Incremental safety-net sync: everything touched since the cursor (5-minute overlap). */
async function syncRecent(businessId, fallbackSince) {
  const settings = await getSettings(businessId);
  const start = settings.syncCursor ? new Date(settings.syncCursor) : fallbackSince;
  let cursor = start;
  let since = new Date(start.getTime() - 5 * 60 * 1000);
  let total = 0;
  for (;;) {
    const sales = await Sale.find({ businessId, updatedAt: { $gt: since } }).sort({ updatedAt: 1 }).limit(200).lean();
    if (!sales.length) break;
    const r = await syncSaleBatch(businessId, sales, settings);
    total += r.linked;
    const lastAt = new Date(sales[sales.length - 1].updatedAt);
    if (lastAt > cursor) cursor = lastAt;
    if (sales.length < 200 || lastAt.getTime() <= since.getTime()) break; // done, or no forward progress
    since = lastAt;
  }
  if (cursor.getTime() !== start.getTime() || !settings.syncCursor) {
    await CrmSettings.updateOne({ businessId }, { $set: { syncCursor: cursor } });
    settingsCache.delete(String(businessId));
  }
  return total;
}

/**
 * Manual capture + step-by-step report for ONE sale (POST /crm/sales/:id/capture).
 * Safe to run repeatedly: it is the same idempotent sync the automatic hooks use.
 */
async function diagnoseSale(businessId, saleId) {
  const steps = [];
  const step = (name, ok, detail) => steps.push({ name, ok: !!ok, detail });

  if (!mongoose.isValidObjectId(saleId)) throw ApiError.badRequest('Invalid sale id');
  const sale = await Sale.findOne({ _id: saleId, businessId }).lean();
  step('Sale found', sale, sale
    ? { status: saleStatus(sale), total: saleTotal(sale), customerId: sale.customerId || null, lines: saleItems(sale).length }
    : 'No sale with this id in this business');
  if (!sale) return { steps };

  const txns = await MpesaTransaction.find({ businessId, saleId: sale._id })
    .select('reference status channel phone mpesaReceiptNumber').lean();
  step('M-PESA payment attached to the sale', txns.length, txns.length ? txns : 'None - cash/card/credit sales have no phone to capture unless a customer was picked');

  const ctx = (await loadMpesaContext(businessId, [sale._id])).get(String(sale._id));
  step('Payer phone is a valid Kenyan number', (ctx && ctx.phone) || sale.customerId, ctx ? { phone: ctx.phone || null } : 'No successful M-PESA payment found');

  try {
    const settings = await getSettings(businessId);
    const r = await syncSaleBatch(businessId, [sale], settings);
    step('Capture ran', r.linked > 0 && !r.errors.length, r);
  } catch (e) {
    step('Capture ran', false, { error: e.message, where: String(e.stack || '').split('\n').slice(0, 5) });
  }

  const purchase = await CustomerPurchase.findOne({ businessId, saleId: sale._id }).lean();
  step('Purchase recorded against a customer', purchase, purchase ? { customerId: purchase.customerId, linkedBy: purchase.linkedBy } : null);
  return { steps };
}

/* ------------------------------ recompute stats ------------------------------ */
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

async function recomputeCustomers(businessId, customerIds, settings, now = new Date()) {
  const ids = customerIds ? [...new Set(customerIds.map(String))] : null;
  const groups = ids ? chunk(ids, 500) : [null];
  for (const group of groups) {
    await recomputeGroup(businessId, group, settings, now);
  }
}

async function recomputeGroup(businessId, ids, settings, now) {
  const match = { businessId: oid(businessId), voided: { $ne: true } };
  if (ids) match.customerId = { $in: ids.map(oid) };
  const windowStart = new Date(now.getTime() - settings.frequentWindowDays * DAY);
  const inWindow = { $gte: ['$purchasedAt', windowStart] };

  const [rows, catRows, methodRows] = await Promise.all([
    CustomerPurchase.aggregate([
      { $match: match },
      { $sort: { purchasedAt: -1 } },
      {
        $group: {
          _id: '$customerId',
          gross: { $sum: '$amountCents' },
          refunded: { $sum: '$refundedCents' },
          count: { $sum: 1 },
          first: { $min: '$purchasedAt' },
          last: { $max: '$purchasedAt' },
          lastAmount: { $first: '$amountCents' },
          lastMethods: { $first: '$paymentMethods' },
          lastReceipt: { $first: '$mpesaReceipt' },
          recentCount: { $sum: { $cond: [inWindow, 1, 0] } },
          recentSpent: { $sum: { $cond: [inWindow, { $subtract: ['$amountCents', '$refundedCents'] }, 0] } },
        },
      },
    ]).allowDiskUse(true),
    CustomerPurchase.aggregate([
      { $match: match },
      { $unwind: '$categories' },
      { $group: { _id: { c: '$customerId', n: '$categories.name' }, spent: { $sum: '$categories.amountCents' }, count: { $sum: 1 } } },
    ]).allowDiskUse(true),
    CustomerPurchase.aggregate([
      { $match: match },
      { $unwind: '$paymentMethods' },
      { $group: { _id: { c: '$customerId', m: '$paymentMethods' }, count: { $sum: 1 } } },
    ]).allowDiskUse(true),
  ]);

  const catsBy = new Map();
  catRows.forEach((r) => {
    const k = String(r._id.c);
    if (!catsBy.has(k)) catsBy.set(k, []);
    catsBy.get(k).push({ name: r._id.n, spentCents: r.spent, count: r.count });
  });
  const mixBy = new Map();
  methodRows.forEach((r) => {
    const k = String(r._id.c);
    if (!mixBy.has(k)) mixBy.set(k, []);
    mixBy.get(k).push({ method: r._id.m, count: r.count });
  });

  const seen = new Set();
  const ops = rows.map((r) => {
    seen.add(String(r._id));
    const net = Math.max(0, r.gross - r.refunded);
    const stats = {
      purchaseCount: r.count,
      totalSpentCents: net,
      refundedCents: r.refunded,
      avgOrderCents: Math.round(net / Math.max(1, r.count)),
      firstPurchaseAt: r.first,
      lastPurchaseAt: r.last,
      lastPurchaseCents: r.lastAmount,
      lastPaymentMethods: r.lastMethods || [],
      lastMpesaReceipt: r.lastReceipt || undefined,
      recentPurchases: r.recentCount,
      recentSpentCents: Math.max(0, r.recentSpent),
      topCategories: (catsBy.get(String(r._id)) || []).sort((a, b) => b.spentCents - a.spentCents).slice(0, 5),
      paymentMix: (mixBy.get(String(r._id)) || []).sort((a, b) => b.count - a.count),
      computedAt: now,
    };
    stats.paymentMethods = stats.paymentMix.map((m) => m.method);
    Object.assign(stats, engine.classify(stats, settings, now));
    return { updateOne: { filter: { _id: r._id, businessId }, update: { $set: { crm: stats } } } };
  });

  // customers who used to have purchases but now have none (all voided / re-linked) -> reset to prospect
  let resetIds;
  if (ids) resetIds = ids.filter((id) => !seen.has(id));
  else {
    resetIds = (await Customer.find({ businessId, 'crm.purchaseCount': { $gt: 0 }, _id: { $nin: [...seen].map(oid) } }).select('_id').lean()).map((c) => String(c._id));
  }
  resetIds.forEach((id) => {
    ops.push({
      updateOne: {
        filter: { _id: oid(id), businessId },
        update: { $set: { crm: { lifecycle: 'prospect', isVip: false, purchaseCount: 0, totalSpentCents: 0, refundedCents: 0, avgOrderCents: 0, recentPurchases: 0, recentSpentCents: 0, topCategories: [], paymentMethods: [], paymentMix: [], computedAt: now } } },
      },
    });
  });

  if (ops.length) await Customer.bulkWrite(ops, { ordered: false, timestamps: false });
}

/** Time passes => labels drift (active -> inactive). Cheap full recompute for one business. */
async function refreshLifecycles(businessId) {
  const settings = await getSettings(businessId);
  await recomputeCustomers(businessId, null, settings);
}

/* ------------------------------ rebuild workflow ------------------------------ */
const rebuilds = new Map(); // businessId -> status

function getRebuildStatus(businessId) {
  return rebuilds.get(String(businessId)) || { state: 'idle' };
}

async function backfillPhones(businessId, status) {
  const cursor = Customer.find({ businessId, phone: { $exists: true, $ne: '' }, phoneNormalized: { $exists: false } })
    .select('_id phone createdAt').sort({ createdAt: 1 }).cursor();
  for await (const c of cursor) {
    const n = normalizePhone(c.phone);
    if (!n) { status.invalidPhones += 1; continue; }
    const owner = await Customer.findOne({ businessId, phoneNormalized: n }).select('_id').lean();
    if (owner) {
      await Customer.updateOne({ _id: c._id }, { $set: { duplicateOf: owner._id } }, { timestamps: false });
      status.duplicates += 1;
    } else {
      await Customer.updateOne({ _id: c._id }, { $set: { phoneNormalized: n } }, { timestamps: false });
      status.phonesFixed += 1;
    }
  }
}

function startRebuild(businessId) {
  const key = String(businessId);
  const current = rebuilds.get(key);
  if (current && current.state === 'running') return current;

  const status = { state: 'running', startedAt: new Date(), stage: 'phones', phonesFixed: 0, invalidPhones: 0, duplicates: 0, salesScanned: 0, purchasesLinked: 0, error: null };
  rebuilds.set(key, status);

  setImmediate(async () => {
    try {
      const settings = await getSettings(businessId);
      await backfillPhones(businessId, status);

      status.stage = 'sales';
      let lastId = null;
      for (;;) {
        const q = { businessId };
        if (lastId) q._id = { $gt: lastId };
        const sales = await Sale.find(q).sort({ _id: 1 }).limit(300).lean();
        if (!sales.length) break;
        const r = await syncSaleBatch(businessId, sales, settings);
        status.salesScanned += sales.length;
        status.purchasesLinked += r.linked;
        lastId = sales[sales.length - 1]._id;
      }

      status.stage = 'stats';
      await recomputeCustomers(businessId, null, settings);
      await CrmSettings.updateOne({ businessId }, { $set: { lastRebuildAt: new Date(), syncCursor: new Date() } });
      settingsCache.delete(key);
      status.state = 'done';
    } catch (e) {
      console.error('[crm] rebuild failed', e);
      status.state = 'failed';
      status.error = e.message;
    }
    status.finishedAt = new Date();
  });
  return status;
}

/* ------------------------------ segments / filters ------------------------------ */
async function resolveSegment(businessId, segmentId) {
  const settings = await getSettings(businessId);
  if (String(segmentId).startsWith('sys:')) {
    const seg = engine.systemSegments(settings).find((s) => s.id === segmentId);
    if (!seg) throw ApiError.notFound('Segment not found');
    return seg;
  }
  if (!mongoose.isValidObjectId(segmentId)) throw ApiError.notFound('Segment not found');
  const seg = await CustomerSegment.findOne({ _id: segmentId, businessId }).lean();
  if (!seg) throw ApiError.notFound('Segment not found');
  return seg;
}

function customerFilter(businessId, { rules, match, search, lifecycle, includeArchived } = {}) {
  const parts = [{ businessId: oid(businessId) }];
  if (!includeArchived) parts.push({ status: { $ne: 'inactive' } });
  parts.push({ duplicateOf: { $exists: false } });
  if (lifecycle) parts.push({ 'crm.lifecycle': lifecycle });
  if (search) {
    const term = String(search).trim();
    const rx = { $regex: engine.escapeRegex(term), $options: 'i' };
    const or = [{ name: rx }, { email: rx }, { customerNumber: rx }, { phone: rx }];
    const digits = normalizePhone(term);
    if (digits) or.push({ phoneNormalized: digits });
    parts.push({ $or: or });
  }
  const ruleFilter = engine.buildRuleFilter(rules, match);
  if (Object.keys(ruleFilter).length) parts.push(ruleFilter);
  return { $and: parts };
}

async function listSegments(businessId) {
  const settings = await getSettings(businessId);
  const sys = engine.systemSegments(settings).map((s) => ({ ...s, system: true }));
  const custom = await CustomerSegment.find({ businessId }).sort({ name: 1 }).lean();
  const all = [...sys, ...custom.map((c) => ({ ...c, id: String(c._id), system: false }))];
  const counts = await Promise.all(all.map((s) => Customer.countDocuments(customerFilter(businessId, { rules: s.rules, match: s.match }))));
  return all.map((s, i) => ({ ...s, memberCount: counts[i] }));
}

async function previewSegment(businessId, { rules, match }) {
  const filter = customerFilter(businessId, { rules, match });
  const [count, sample] = await Promise.all([
    Customer.countDocuments(filter),
    Customer.find(filter).sort({ 'crm.totalSpentCents': -1 }).limit(5).select('name phone crm.lifecycle crm.totalSpentCents').lean(),
  ]);
  return { count, sample };
}

async function createSegment(businessId, userId, body) {
  const memberCount = await Customer.countDocuments(customerFilter(businessId, body));
  try {
    return await CustomerSegment.create({ ...body, businessId, createdBy: userId, memberCount });
  } catch (e) {
    if (e.code === 11000) throw ApiError.conflict('You already have a segment with that name');
    throw e;
  }
}

async function updateSegment(businessId, id, body) {
  const memberCount = await Customer.countDocuments(customerFilter(businessId, body));
  try {
    const seg = await CustomerSegment.findOneAndUpdate({ _id: id, businessId }, { $set: { ...body, memberCount } }, { new: true });
    if (!seg) throw ApiError.notFound('Segment not found');
    return seg;
  } catch (e) {
    if (e.code === 11000) throw ApiError.conflict('You already have a segment with that name');
    throw e;
  }
}

async function deleteSegment(businessId, id) {
  const r = await CustomerSegment.deleteOne({ _id: id, businessId });
  if (!r.deletedCount) throw ApiError.notFound('Segment not found');
}

/** Phase 2 entry point: who should a campaign for this segment reach? Only valid phones, one per customer. */
async function getSegmentAudience(businessId, segmentId, { requirePhone = true, limit = 50000 } = {}) {
  const seg = await resolveSegment(businessId, segmentId);
  const filter = customerFilter(businessId, { rules: seg.rules, match: seg.match });
  if (requirePhone) filter.$and.push({ phoneNormalized: { $type: 'string' } });
  return Customer.find(filter).limit(limit).select('_id name phoneNormalized crm.lifecycle').lean();
}

/* ------------------------------ customers ------------------------------ */
const SORTS = {
  spent: { 'crm.totalSpentCents': -1 },
  recent: { 'crm.lastPurchaseAt': -1 },
  visits: { 'crm.purchaseCount': -1 },
  newest: { createdAt: -1 },
  name: { name: 1 },
};

async function listCustomers(businessId, q) {
  let rules; let match;
  if (q.segmentId) {
    const seg = await resolveSegment(businessId, q.segmentId);
    rules = seg.rules; match = seg.match;
  }
  const filter = customerFilter(businessId, { rules, match, search: q.search, lifecycle: q.lifecycle });
  const page = q.page || 1;
  const limit = q.limit || 25;
  const [items, total] = await Promise.all([
    Customer.find(filter)
      .sort({ ...(SORTS[q.sort] || SORTS.spent), _id: 1 })
      .skip((page - 1) * limit).limit(limit)
      .select('name phone phoneNormalized email tags source createdAt crm')
      .lean(),
    Customer.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

async function getProfile(businessId, id) {
  const customer = await Customer.findOne({ _id: id, businessId })
    .select('name phone phoneNormalized email address customerNumber tags source status createdAt crm outstandingBalance creditLimit')
    .lean();
  if (!customer) throw ApiError.notFound('Customer not found');

  const since = new Date(Date.now() - 365 * DAY);
  const [purchases, monthly, segs] = await Promise.all([
    CustomerPurchase.find({ businessId, customerId: id, voided: { $ne: true } }).sort({ purchasedAt: -1 }).limit(25)
      .select('saleId saleNumber amountCents refundedCents itemCount paymentMethods mpesaReceipt purchasedAt linkedBy categories').lean(),
    CustomerPurchase.aggregate([
      { $match: { businessId: oid(businessId), customerId: oid(id), voided: { $ne: true }, purchasedAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$purchasedAt', timezone: TZ } }, spentCents: { $sum: { $subtract: ['$amountCents', '$refundedCents'] } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    listSegments(businessId),
  ]);

  const member = await Promise.all(
    segs.map((s) => Customer.exists({ $and: [{ _id: oid(id) }, customerFilter(businessId, { rules: s.rules, match: s.match, includeArchived: true })] }))
  );
  const segments = segs.filter((_, i) => member[i]).map((s) => ({ id: s.id, name: s.name, color: s.color }));
  return { customer, purchases, monthly: monthly.map((m) => ({ month: m._id, spentCents: m.spentCents, count: m.count })), segments };
}

async function updateTags(businessId, id, tags) {
  const clean = [...new Set((tags || []).map((t) => String(t).trim().slice(0, 24)).filter(Boolean))].slice(0, 10);
  const c = await Customer.findOneAndUpdate({ _id: id, businessId }, { $set: { tags: clean } }, { new: true }).select('tags').lean();
  if (!c) throw ApiError.notFound('Customer not found');
  return c.tags;
}

/* ------------------------------ overview ------------------------------ */
async function getOverview(businessId) {
  const settings = await getSettings(businessId);
  const b = oid(businessId);
  const now = new Date();
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const catStart = new Date(now.getTime() - 90 * DAY);
  const base = { businessId: b, status: { $ne: 'inactive' }, duplicateOf: { $exists: false } };

  const [lifeAgg, totalsAgg, trend, newByMonth, cats, top, newRecent, atRisk, reachable] = await Promise.all([
    Customer.aggregate([{ $match: base }, { $group: { _id: '$crm.lifecycle', count: { $sum: 1 }, revenueCents: { $sum: '$crm.totalSpentCents' } } }]),
    Customer.aggregate([
      { $match: base },
      {
        $group: {
          _id: null,
          customers: { $sum: 1 },
          withPhone: { $sum: { $cond: [{ $eq: [{ $type: '$phoneNormalized' }, 'string'] }, 1, 0] } },
          buyers: { $sum: { $cond: [{ $gt: ['$crm.purchaseCount', 0] }, 1, 0] } },
          repeat: { $sum: { $cond: [{ $gte: ['$crm.purchaseCount', 2] }, 1, 0] } },
          revenueCents: { $sum: '$crm.totalSpentCents' },
        },
      },
    ]),
    CustomerPurchase.aggregate([
      { $match: { businessId: b, voided: { $ne: true }, purchasedAt: { $gte: trendStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$purchasedAt', timezone: TZ } },
          revenueCents: { $sum: { $subtract: ['$amountCents', '$refundedCents'] } },
          orders: { $sum: 1 },
          buyers: { $addToSet: '$customerId' },
        },
      },
      { $project: { revenueCents: 1, orders: 1, buyers: { $size: '$buyers' } } },
      { $sort: { _id: 1 } },
    ]),
    Customer.aggregate([
      { $match: { ...base, 'crm.firstPurchaseAt': { $gte: trendStart } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$crm.firstPurchaseAt', timezone: TZ } }, count: { $sum: 1 } } },
    ]),
    CustomerPurchase.aggregate([
      { $match: { businessId: b, voided: { $ne: true }, purchasedAt: { $gte: catStart } } },
      { $unwind: '$categories' },
      { $group: { _id: '$categories.name', spentCents: { $sum: '$categories.amountCents' } } },
      { $sort: { spentCents: -1 } },
      { $limit: 6 },
    ]),
    Customer.find({ ...base, 'crm.purchaseCount': { $gt: 0 } }).sort({ 'crm.totalSpentCents': -1 }).limit(5).select('name phone crm.lifecycle crm.totalSpentCents crm.purchaseCount crm.lastPurchaseAt').lean(),
    Customer.countDocuments({ ...base, 'crm.firstPurchaseAt': { $gte: new Date(now.getTime() - settings.newWindowDays * DAY) } }),
    Customer.countDocuments(customerFilter(businessId, { rules: engine.systemSegments(settings).find((s) => s.id === 'sys:at-risk').rules })),
    Customer.countDocuments({ ...base, phoneNormalized: { $type: 'string' } }),
  ]);

  const t = totalsAgg[0] || { customers: 0, withPhone: 0, buyers: 0, repeat: 0, revenueCents: 0 };
  const newMap = new Map(newByMonth.map((n) => [n._id, n.count]));
  const lifecycle = Object.fromEntries(engine.LIFECYCLES.map((k) => [k, { count: 0, revenueCents: 0 }]));
  lifeAgg.forEach((l) => { if (lifecycle[l._id]) lifecycle[l._id] = { count: l.count, revenueCents: l.revenueCents }; });

  return {
    kpis: {
      customers: t.customers,
      reachable,
      buyers: t.buyers,
      repeatRate: t.buyers ? Math.round((t.repeat / t.buyers) * 1000) / 10 : 0,
      avgSpendCents: t.buyers ? Math.round(t.revenueCents / t.buyers) : 0,
      revenueCents: t.revenueCents,
      newRecent,
      newWindowDays: settings.newWindowDays,
      atRisk,
    },
    lifecycle,
    trend: trend.map((m) => ({ month: m._id, revenueCents: m.revenueCents, orders: m.orders, buyers: m.buyers, newCustomers: newMap.get(m._id) || 0 })),
    categories: cats.map((c) => ({ name: c._id, spentCents: c.spentCents })),
    topCustomers: top,
    settings,
    lastRebuildAt: settings.lastRebuildAt || null,
  };
}

module.exports = {
  getSettings, updateSettings,
  onSaleCompleted, onPaymentSucceeded, syncSaleBatch, syncRecent, diagnoseSale, recomputeCustomers, refreshLifecycles,
  startRebuild, getRebuildStatus,
  listSegments, previewSegment, createSegment, updateSegment, deleteSegment, getSegmentAudience, resolveSegment, customerFilter,
  listCustomers, getProfile, updateTags, getOverview,
};