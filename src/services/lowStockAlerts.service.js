/**
 * Low stock SMS to the shop owner (opt-in, uses SMS credits). In-app LOW_STOCK / OUT_OF_STOCK notifications are
 * unchanged (notification.service); this only adds the optional text.
 * "Low" = on hand minus reserved <= the row's low-stock threshold (default 5) and still above zero; "out" = zero or less.
 * Only active products that track inventory count (services and archived items never alert).
 */
const BranchInventory = require('../models/BranchInventory');
const Product = require('../models/Product');
const Business = require('../models/Business');
const smsAlerts = require('./sms/alerts.service');

async function lowStockSummary(businessId) {
  const rows = await BranchInventory.find({ businessId }).select('productId quantity reservedQuantity lowStockThreshold').limit(20000).lean();
  if (!rows.length) return { low: 0, out: 0, top: [] };
  const prods = await Product.find({ _id: { $in: [...new Set(rows.map((r) => String(r.productId)))] }, status: { $ne: 'archived' }, trackInventory: true }).select('name').lean();
  const nameOf = new Map(prods.map((p) => [String(p._id), p.name]));
  const flagged = [];
  for (const r of rows) {
    const name = nameOf.get(String(r.productId));
    if (!name) continue;
    const qty = r.quantity;
    if (qty <= 0) flagged.push({ name, quantity: 0, state: 'out' });
    else if (qty - (r.reservedQuantity || 0) <= (r.lowStockThreshold ?? 5)) flagged.push({ name, quantity: qty, state: 'low' });
  }
  // most urgent first: out of stock, then the smallest quantities
  flagged.sort((a, b) => (a.state === b.state ? a.quantity - b.quantity : a.state === 'out' ? -1 : 1));
  return { low: flagged.filter((f) => f.state === 'low').length, out: flagged.filter((f) => f.state === 'out').length, top: flagged.slice(0, 10) };
}

async function runForBusiness(businessId, { manual = false } = {}) {
  const summary = await lowStockSummary(businessId);
  const sms = await smsAlerts.sendLowStockDigest(businessId, summary, { manual });
  return { summary: { low: summary.low, out: summary.out }, sms };
}

/** Every active business that switched the low-stock text on. */
async function runAll() {
  const cursor = Business.find({
    status: 'active', subscriptionStatus: { $nin: ['suspended', 'cancelled'] }, 'smsAlerts.lowStockDigest.enabled': true,
  }).select('_id').lean().cursor();
  let n = 0;
  for await (const b of cursor) {
    try { await runForBusiness(b._id); n += 1; } catch (e) { console.error('[low stock alerts] business failed', String(b._id), e.message); }
  }
  return n;
}

module.exports = { lowStockSummary, runForBusiness, runAll };
