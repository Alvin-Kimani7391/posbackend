/**
 * Pure bill maths for the restaurant module (no database). All money is integer cents.
 * A BILL LINE is a priced slice of an order item:
 *   { orderItemId, menuItemId, productId, sku, categoryId, categoryName, name, variantName, modifiersText, quantity, unitPrice,
 *     taxRate, serviceChargeable, seatNumber, isComp, gross, discount, taxAmount, total, cost, compValue }
 * Splitting NEVER recomputes a slice from prices: it carves exact integer components out of the parent line
 * (parent = line - child, component by component), so children always add back to the parent to the cent.
 */
const EPS = 1e-9;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const fail = (code) => { const err = new Error(code); err.code = code; return err; };

function lineMath(gross, discount, taxRate = 0, taxInclusive = true) {
  const net = gross - discount;
  if (taxInclusive) return { taxAmount: net - Math.round(net / (1 + taxRate / 100)), total: net };
  const taxAmount = Math.round(net * (taxRate / 100));
  return { taxAmount, total: net + taxAmount };
}

/** Largest-remainder allocation: integer shares of `total` proportional to `weights`; shares always sum to `total`. */
function allocate(total, weights) {
  total = Math.round(total);
  const n = weights.length;
  if (!n) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const s = sum > 0 ? sum : n;
  const raw = w.map((x) => (total * x) / s);
  const out = raw.map(Math.floor);
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rem > 0 && k < order.length; k += 1, rem -= 1) out[order[k].i] += 1;
  return out;
}

/** Order items that appear on a bill: not cancelled, not drafts, and not zero-priced combo components. */
const isBillable = (item) => item.status !== 'CANCELLED' && item.status !== 'DRAFT' && !item.parentItemId;

function buildLine(item, taxInclusive = true) {
  const comp = !!item.isComplimentary;
  const qty = item.quantity;
  const fullValue = Math.round(item.unitPrice * qty);
  const gross = comp ? 0 : fullValue;
  const discount = comp ? 0 : Math.min(item.discount || 0, gross);
  const { taxAmount, total } = lineMath(gross, discount, item.taxRate || 0, taxInclusive);
  return {
    orderItemId: item._id, menuItemId: item.menuItemId, productId: item.productId, sku: item.sku, categoryId: item.categoryId, categoryName: item.categoryName,
    name: item.name, variantName: item.variantName,
    modifiersText: (item.modifiers || []).map((m) => (m.quantity > 1 ? `${m.name} x${m.quantity}` : m.name)).join(', '),
    quantity: qty, unitPrice: item.unitPrice, taxRate: item.taxRate || 0,
    serviceChargeable: item.serviceChargeable !== false, seatNumber: item.seatNumber,
    isComp: comp, gross, discount, taxAmount, total,
    cost: Math.round((item.costUnit || 0) * qty), compValue: comp ? fullValue : 0,
  };
}

const COMPONENTS = ['gross', 'discount', 'taxAmount', 'total', 'cost', 'compValue'];
const plain = (l) => (typeof l.toObject === 'function' ? l.toObject({ transform: false, virtuals: false }) : { ...l });

function carveLine(line, ratio, exactTotal) {
  const src = plain(line);
  const child = { ...src }; const parent = { ...src };
  if (ratio >= 1 - EPS) { parent.quantity = 0; COMPONENTS.forEach((k) => { parent[k] = 0; }); return { child, parent }; }
  child.quantity = round4(src.quantity * ratio);
  COMPONENTS.forEach((k) => { child[k] = Math.round((src[k] || 0) * ratio); });
  if (exactTotal !== undefined) child.total = exactTotal;
  parent.quantity = round4(src.quantity - child.quantity);
  COMPONENTS.forEach((k) => { parent[k] = (src[k] || 0) - child[k]; });
  return { child, parent };
}
const isEmpty = (l) => l.quantity <= EPS && l.total === 0 && l.gross === 0;

function carveByQuantity(lines, selections) {
  const byId = new Map(lines.map((l, i) => [String(l.orderItemId), i]));
  const taken = []; const remaining = lines.map(plain); const seen = new Set();
  for (const sel of selections) {
    const key = String(sel.orderItemId); const idx = byId.get(key);
    if (idx === undefined) throw fail('ITEM_NOT_ON_BILL');
    if (seen.has(key)) throw fail('DUPLICATE_SELECTION');
    seen.add(key);
    const line = remaining[idx];
    if (!(sel.quantity > 0) || sel.quantity > line.quantity + EPS) throw fail('QUANTITY_EXCEEDS_LINE');
    const { child, parent } = carveLine(line, Math.min(1, sel.quantity / line.quantity));
    taken.push(child); remaining[idx] = parent;
  }
  return { taken, remaining: remaining.filter((l) => !isEmpty(l)) };
}

function carveByAmount(lines, amount) {
  const totals = lines.map((l) => l.total);
  const sum = totals.reduce((a, b) => a + b, 0);
  if (!(amount > 0) || amount > sum) throw fail('AMOUNT_OUT_OF_RANGE');
  const shares = allocate(amount, totals);
  const taken = []; const remaining = [];
  lines.forEach((l, i) => {
    const line = plain(l);
    if (shares[i] === 0) { remaining.push(line); return; }
    const { child, parent } = carveLine(line, shares[i] / line.total, shares[i]);
    taken.push(child);
    if (!isEmpty(parent)) remaining.push(parent);
  });
  return { taken, remaining };
}

function splitEqual(lines, n) {
  const total = lines.reduce((s, l) => s + l.total, 0);
  const amounts = allocate(total, Array(n).fill(1));
  const parts = []; let remaining = lines.map(plain);
  for (let i = 0; i < n - 1; i += 1) {
    if (amounts[i] === 0) { parts.push([]); continue; }
    const r = carveByAmount(remaining, amounts[i]);
    parts.push(r.taken); remaining = r.remaining;
  }
  parts.push(remaining);
  return parts;
}

function groupBySeat(lines) {
  const map = new Map();
  for (const l of lines) { const k = l.seatNumber ?? 0; if (!map.has(k)) map.set(k, []); map.get(k).push(plain(l)); }
  return map;
}

function mergeLines(base, extra) {
  const out = base.map(plain);
  for (const e of extra.map(plain)) {
    const i = out.findIndex((l) => String(l.orderItemId) === String(e.orderItemId));
    if (i === -1) { out.push(e); continue; }
    out[i].quantity = round4(out[i].quantity + e.quantity);
    COMPONENTS.forEach((k) => { out[i][k] = (out[i][k] || 0) + (e[k] || 0); });
  }
  return out;
}

function sumLines(lines) {
  const t = { items: 0, gross: 0, discount: 0, tax: 0, cost: 0, compValue: 0, chargeable: 0 };
  for (const l of lines) {
    t.items += l.total; t.gross += l.gross; t.discount += l.discount; t.tax += l.taxAmount; t.cost += l.cost; t.compValue += l.compValue;
    if (l.serviceChargeable && !l.isComp) t.chargeable += l.total;
  }
  return t;
}
const taxIn = (amount, rate) => amount - Math.round(amount / (1 + (rate || 0) / 100));

/** Service charge = percent of the chargeable lines (net of discounts); a FINAL amount containing scTaxRate % tax. Tips are separate. */
function billTotals(lines, { scPercent = 0, scTaxRate = 0, scWaived = false } = {}) {
  const s = sumLines(lines);
  const serviceCharge = scWaived || !scPercent ? 0 : Math.round((s.chargeable * scPercent) / 100);
  const scTax = serviceCharge ? taxIn(serviceCharge, scTaxRate) : 0;
  return { gross: s.gross, discount: s.discount, itemsTotal: s.items, serviceCharge, serviceChargeTax: scTax, tax: s.tax + scTax, total: s.items + serviceCharge, cost: s.cost, compValue: s.compValue };
}

/** Bill-level discount spread over non-comp lines as line-level discounts (so splitting and tax stay correct). */
function applyDiscount(lines, { type, value }, taxInclusive = true) {
  const eligible = lines.map((l, i) => ({ l: plain(l), i })).filter((x) => !x.l.isComp && x.l.gross - x.l.discount > 0);
  const netGross = eligible.reduce((s, x) => s + (x.l.gross - x.l.discount), 0);
  const amount = type === 'PERCENT' ? Math.round((netGross * value) / 100) : Math.round(value);
  if (!(amount > 0)) throw fail('NOTHING_TO_DISCOUNT');
  if (amount > netGross) throw fail('DISCOUNT_EXCEEDS_BILL');
  const shares = allocate(amount, eligible.map((x) => x.l.gross - x.l.discount));
  const out = lines.map(plain);
  eligible.forEach((x, k) => {
    const l = out[x.i];
    l.discount += Math.min(shares[k], l.gross - l.discount);
    Object.assign(l, lineMath(l.gross, l.discount, l.taxRate, taxInclusive));
  });
  return { lines: out, applied: amount, percentOfBill: netGross ? (amount / netGross) * 100 : 0 };
}

function orderTotals(items, { taxInclusive = true, scPercent = 0, scTaxRate = 0 } = {}) {
  return billTotals(items.filter(isBillable).map((i) => buildLine(i, taxInclusive)), { scPercent, scTaxRate });
}

module.exports = { lineMath, allocate, isBillable, buildLine, carveLine, carveByQuantity, carveByAmount, splitEqual, groupBySeat, mergeLines, sumLines, billTotals, applyDiscount, orderTotals, taxIn, round4, COMPONENTS };
