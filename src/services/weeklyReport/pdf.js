'use strict';
/**
 * weeklyReport/pdf.js - the two PDF reports attached to the weekly email:
 *   buildLowStockPdf(data)  -> Buffer     buildExpiryPdf(data) -> Buffer
 * Pure pdf-lib (no browser, no native deps). A4 landscape, brand header band, KPI cards, chart bars, zebra tables
 * with repeating headers and status chips, page footers "Page x of y".
 */
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PAGE = { w: 841.89, h: 595.28 };
const M = 36;                       // side margin
const C = {
  brand: [0.059, 0.463, 0.431], brandDark: [0.024, 0.298, 0.278], brandSoft: [0.925, 0.992, 0.961],
  ink: [0.059, 0.09, 0.165], body: [0.2, 0.255, 0.333], muted: [0.392, 0.455, 0.545], faint: [0.58, 0.64, 0.72],
  line: [0.886, 0.91, 0.941], zebra: [0.973, 0.98, 0.99], white: [1, 1, 1], head: [0.059, 0.09, 0.165],
  danger: [0.863, 0.149, 0.149], dangerSoft: [0.996, 0.886, 0.886], warn: [0.851, 0.467, 0.024], warnSoft: [0.996, 0.953, 0.78],
  info: [0.145, 0.388, 0.922], infoSoft: [0.859, 0.918, 0.996], ok: [0.086, 0.639, 0.29], okSoft: [0.863, 0.988, 0.906],
};
const TONE = { danger: [C.danger, C.dangerSoft], warning: [C.warn, C.warnSoft], info: [C.info, C.infoSoft], success: [C.ok, C.okSoft], neutral: [C.muted, C.zebra], brand: [C.brand, C.brandSoft] };
const col = (c) => rgb(c[0], c[1], c[2]);

class Report {
  static async create(meta) {
    const pdf = await PDFDocument.create();
    pdf.setTitle(meta.title); pdf.setAuthor(meta.brand || 'Six Star POS'); pdf.setCreator('Six Star POS'); pdf.setProducer('Six Star POS');
    pdf.setSubject(`${meta.business} - ${meta.period}`);
    const r = new Report(pdf, meta);
    r.f = { reg: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold), ital: await pdf.embedFont(StandardFonts.HelveticaOblique) };
    r.chars = new Set(r.f.reg.getCharacterSet());
    r.newPage();
    return r;
  }
  constructor(pdf, meta) { this.pdf = pdf; this.meta = meta; this.pages = []; this.W = PAGE.w - M * 2; }

  clean(s) {
    return String(s == null ? '' : s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/ /g, ' ')
      .split('').map((ch) => (this.chars.has(ch.codePointAt(0)) ? ch : '?')).join('');
  }
  width(t, size, font = this.f.reg) { return font.widthOfTextAtSize(t, size); }
  fit(text, maxW, size, font = this.f.reg) {
    let t = this.clean(text);
    if (this.width(t, size, font) <= maxW) return t;
    while (t.length > 1 && this.width(`${t}...`, size, font) > maxW) t = t.slice(0, -1);
    return `${t.trimEnd()}...`;
  }
  text(t, x, y, { size = 9, font = this.f.reg, color = C.body, align = 'left', maxW } = {}) {
    let s = maxW ? this.fit(t, maxW, size, font) : this.clean(t);
    const w = this.width(s, size, font);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.page.drawText(s, { x: px, y, size, font, color: col(color) });
    return w;
  }
  rect(x, y, w, h, color, opts = {}) { this.page.drawRectangle({ x, y, width: w, height: h, color: col(color), ...opts }); }
  hline(y, x1 = M, x2 = PAGE.w - M, color = C.line, thickness = 0.6) { this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color: col(color) }); }

  /* ----------------------------------------------------------- pages */
  newPage() {
    const first = this.pages.length === 0;
    this.page = this.pdf.addPage([PAGE.w, PAGE.h]);
    this.pages.push(this.page);
    if (first) {
      const hH = 104;
      this.rect(0, PAGE.h - hH, PAGE.w, hH, C.brandDark);
      this.rect(0, PAGE.h - hH, PAGE.w * 0.42, hH, C.brand);
      this.rect(PAGE.w - 190, PAGE.h - hH, 190, hH, [0.04, 0.38, 0.35]);
      this.rect(0, PAGE.h - hH - 3, PAGE.w, 3, [0.98, 0.75, 0.14]);
      this.text((this.meta.brand || 'SIX STAR POS').toUpperCase(), M, PAGE.h - 30, { size: 9, font: this.f.bold, color: [0.8, 0.98, 0.93] });
      this.text(this.meta.kicker || 'WEEKLY REPORT', M, PAGE.h - 44, { size: 7.5, font: this.f.reg, color: [0.65, 0.92, 0.86] });
      this.text(this.meta.title, M, PAGE.h - 72, { size: 25, font: this.f.bold, color: C.white });
      this.text(this.meta.tagline || '', M, PAGE.h - 91, { size: 9.5, color: [0.78, 0.95, 0.9], maxW: 520 });
      this.text(this.meta.business, PAGE.w - M, PAGE.h - 46, { size: 13, font: this.f.bold, color: C.white, align: 'right', maxW: 300 });
      this.text(this.meta.period, PAGE.w - M, PAGE.h - 62, { size: 9, color: [0.8, 0.98, 0.93], align: 'right' });
      this.text(`Generated ${this.meta.generated}`, PAGE.w - M, PAGE.h - 76, { size: 8, color: [0.65, 0.92, 0.86], align: 'right' });
      this.y = PAGE.h - hH - 22;
    } else {
      this.rect(0, PAGE.h - 30, PAGE.w, 30, C.brandDark);
      this.rect(0, PAGE.h - 30, 120, 30, C.brand);
      this.text((this.meta.brand || 'SIX STAR POS').toUpperCase(), M, PAGE.h - 19, { size: 8, font: this.f.bold, color: C.white });
      this.text(this.meta.title, 160, PAGE.h - 19, { size: 9, font: this.f.bold, color: C.white });
      this.text(`${this.meta.business}  |  ${this.meta.period}`, PAGE.w - M, PAGE.h - 19, { size: 8, color: [0.8, 0.98, 0.93], align: 'right', maxW: 400 });
      this.y = PAGE.h - 54;
    }
  }
  ensure(h) { if (this.y - h < 46) this.newPage(); }

  /* ------------------------------------------------------ components */
  section(title, sub) {
    this.ensure(46);
    this.rect(M, this.y - 14, 4, 18, C.brand);
    this.text(title, M + 12, this.y - 9, { size: 13, font: this.f.bold, color: C.ink });
    if (sub) this.text(sub, M + 12, this.y - 22, { size: 8.5, color: C.muted, maxW: this.W - 12 });
    this.y -= sub ? 38 : 28;
  }
  kpis(cards) {
    this.ensure(76);
    const gap = 10; const n = cards.length; const w = (this.W - gap * (n - 1)) / n; const h = 66;
    cards.forEach((c, i) => {
      const x = M + i * (w + gap); const [fg, bg] = TONE[c.tone || 'neutral'];
      this.rect(x, this.y - h, w, h, C.white, { borderColor: col(C.line), borderWidth: 0.8 });
      this.rect(x, this.y - h, 4, h, fg);
      this.rect(x + w - 34, this.y - 8 - 16, 22, 16, bg);
      this.text(c.label.toUpperCase(), x + 14, this.y - 16, { size: 7, font: this.f.bold, color: C.muted, maxW: w - 50 });
      this.text(c.value, x + 14, this.y - 40, { size: 17, font: this.f.bold, color: fg === C.muted ? C.ink : fg, maxW: w - 22 });
      if (c.sub) this.text(c.sub, x + 14, this.y - 56, { size: 7.5, color: C.muted, maxW: w - 22 });
    });
    this.y -= h + 18;
  }
  /** horizontal bars: items = [{label, value, right, tone}] */
  bars(items, { width = this.W, x = M, rowH = 20, labelW = 78 } = {}) {
    const max = Math.max(1, ...items.map((i) => i.value));
    items.forEach((it) => {
      this.ensure(rowH + 4);
      const [fg, bg] = TONE[it.tone || 'brand'];
      this.text(it.label, x, this.y - 12, { size: 8.5, font: this.f.bold, color: C.body, maxW: labelW - 6 });
      const bx = x + labelW; const bw = width - labelW - 150;
      this.rect(bx, this.y - 15, bw, 12, bg);
      if (it.value > 0) this.rect(bx, this.y - 15, Math.max(3, (it.value / max) * bw), 12, fg);
      this.text(it.right || '', x + width, this.y - 12, { size: 8.5, font: this.f.bold, color: C.ink, align: 'right' });
      this.y -= rowH;
    });
    this.y -= 6;
  }
  note(title, lines, tone = 'info') {
    const [fg, bg] = TONE[tone];
    const h = 22 + lines.length * 13;
    this.ensure(h + 8);
    this.rect(M, this.y - h, this.W, h, bg); this.rect(M, this.y - h, 4, h, fg);
    this.text(title, M + 14, this.y - 15, { size: 9.5, font: this.f.bold, color: fg });
    lines.forEach((l, i) => this.text(l, M + 14, this.y - 29 - i * 13, { size: 8.5, color: C.body, maxW: this.W - 28 }));
    this.y -= h + 14;
  }
  /**
   * columns: [{ key|get, label, w (weight), align, chip: (row)=>{text,tone}, bold, color:(row)=>colour }]
   * rows: array; opts.tone(row) -> 'danger' row tint; opts.totals: {label, cells:{key:text}}
   */
  table(columns, rows, { rowH = 19, totals, max = 500, moreText } = {}) {
    const tw = columns.reduce((a, c) => a + c.w, 0);
    const widths = columns.map((c) => (c.w / tw) * this.W);
    const xs = widths.reduce((acc, w, i) => { acc.push(i ? acc[i - 1] + widths[i - 1] : M); return acc; }, []);
    const header = () => {
      this.ensure(rowH + 30);
      this.rect(M, this.y - 20, this.W, 20, C.head);
      columns.forEach((c, i) => {
        const pad = 7; const x = c.align === 'right' ? xs[i] + widths[i] - pad : c.align === 'center' ? xs[i] + widths[i] / 2 : xs[i] + pad;
        this.text(c.label.toUpperCase(), x, this.y - 13, { size: 6.8, font: this.f.bold, color: C.white, align: c.align || 'left', maxW: widths[i] - pad * 2 });
      });
      this.y -= 20;
    };
    header();
    const shown = rows.slice(0, max);
    shown.forEach((r, ri) => {
      if (this.y - rowH < 46) { this.newPage(); header(); }
      const tint = totals ? null : null;
      this.rect(M, this.y - rowH, this.W, rowH, ri % 2 ? C.zebra : C.white);
      columns.forEach((c, i) => {
        const pad = 7; const v = c.get ? c.get(r, ri) : r[c.key];
        const cx = xs[i];
        if (c.chip) {
          const ch = c.chip(r); if (!ch) return;
          const [fg, bg] = TONE[ch.tone || 'neutral']; const tw2 = this.width(this.clean(ch.text), 6.8, this.f.bold) + 12;
          const x = c.align === 'right' ? cx + widths[i] - pad - tw2 : cx + pad;
          this.rect(x, this.y - rowH + 4.5, tw2, rowH - 9, bg);
          this.text(ch.text, x + 6, this.y - rowH + 7.5, { size: 6.8, font: this.f.bold, color: fg });
          return;
        }
        const x = c.align === 'right' ? cx + widths[i] - pad : c.align === 'center' ? cx + widths[i] / 2 : cx + pad;
        const colr = c.color ? c.color(r) : (c.bold ? C.ink : C.body);
        this.text(v == null ? '' : v, x, this.y - rowH + 6.5, { size: 8, font: c.bold ? this.f.bold : this.f.reg, color: colr, align: c.align || 'left', maxW: widths[i] - pad * 2 });
      });
      this.y -= rowH;
    });
    if (rows.length > shown.length) {
      this.ensure(22);
      this.text(moreText || `+ ${rows.length - shown.length} more not shown - open the POS for the full list.`, M + 7, this.y - 14, { size: 8, font: this.f.ital, color: C.muted });
      this.y -= 22;
    }
    if (totals) {
      this.ensure(rowH + 4);
      this.rect(M, this.y - rowH - 2, this.W, rowH + 2, C.brandSoft);
      this.hline(this.y, M, M + this.W, C.brand, 1);
      columns.forEach((c, i) => {
        const pad = 7; const t = totals[c.key]; if (t == null) return;
        const x = c.align === 'right' ? xs[i] + widths[i] - pad : xs[i] + pad;
        this.text(t, x, this.y - rowH + 5, { size: 8.5, font: this.f.bold, color: C.brandDark, align: c.align || 'left', maxW: widths[i] - pad * 2 });
      });
      this.y -= rowH + 2;
    }
    this.y -= 16;
  }

  /* ----------------------------------------------------------- finish */
  async finish() {
    const n = this.pages.length;
    this.pages.forEach((pg, i) => {
      this.page = pg;
      this.hline(34, M, PAGE.w - M);
      this.text(`${this.meta.brand || 'Six Star POS'}  |  ${this.meta.footer || 'Confidential - prepared for the shop management'}`, M, 20, { size: 7.5, color: C.faint, maxW: 560 });
      this.text(`Page ${i + 1} of ${n}`, PAGE.w - M, 20, { size: 7.5, font: this.f.bold, color: C.muted, align: 'right' });
    });
    return Buffer.from(await this.pdf.save());
  }
}

const dateText = (d, tz) => (d ? new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(d)) : '-');
const nf = (n) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const rangeText = (a, b, tz) => `${dateText(`${a}T12:00:00Z`, 'UTC')} - ${dateText(`${b}T12:00:00Z`, 'UTC')}`;
const genText = (data) => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: data.tz }).format(data.generatedAt);
const BRAND = () => process.env.BREVO_SENDER_NAME || 'Six Star POS';

/* ============================================================ LOW STOCK */
async function buildLowStockPdf(data) {
  const { lowStock: L, fmt } = data;
  const r = await Report.create({
    brand: BRAND(), kicker: 'WEEKLY INVENTORY REPORT', title: 'Low Stock Alert Report', tagline: 'Everything that is out of stock or running low, with what to reorder.',
    business: data.business.name, period: `Week ending ${dateText(`${data.sales.period.end}T12:00:00Z`, 'UTC')}`, generated: genText(data),
  });
  r.kpis([
    { label: 'Out of stock', value: nf(L.outCount), sub: 'Customers cannot buy these now', tone: L.outCount ? 'danger' : 'success' },
    { label: 'Running low', value: nf(L.lowCount), sub: 'At or below the minimum level', tone: L.lowCount ? 'warning' : 'success' },
    { label: 'Total needing attention', value: nf(L.total), sub: `${L.byBranch.length} branch${L.byBranch.length === 1 ? '' : 'es'} affected`, tone: 'info' },
    { label: 'Est. cost to restock', value: fmt(L.reorderCost), sub: 'To reach 2x the minimum level', tone: 'brand' },
  ]);

  if (!L.total) {
    r.note('All stocked up', ['No product is out of stock or below its minimum level this week. Nothing to reorder.'], 'success');
    return r.finish();
  }

  if (L.byBranch.length > 0) {
    r.section('Where the gaps are', 'Items out of stock or low, by branch');
    r.bars(L.byBranch.slice(0, 8).map((b) => ({ label: b.branch, value: b.out + b.low, tone: b.out ? 'danger' : 'warning', right: `${b.out} out  |  ${b.low} low` })));
  }

  const cols = [
    { label: '#', w: 3.2, get: (_, i) => i + 1, color: () => C.faint },
    { label: 'Product', w: 24, key: 'name', bold: true },
    { label: 'SKU', w: 10, key: 'sku' },
    { label: 'Branch', w: 12, key: 'branch' },
    { label: 'On hand', w: 7, align: 'right', get: (x) => nf(x.quantity), bold: true },
    { label: 'Min level', w: 7, align: 'right', get: (x) => nf(x.threshold) },
    { label: 'Status', w: 9, chip: (x) => (x.state === 'out' ? { text: 'OUT OF STOCK', tone: 'danger' } : { text: 'LOW', tone: 'warning' }) },
    { label: 'Unit cost', w: 9, align: 'right', get: (x) => fmt(x.cost) },
    { label: 'Reorder qty', w: 8, align: 'right', get: (x) => nf(x.reorderQty), bold: true },
    { label: 'Est. cost', w: 10, align: 'right', get: (x) => fmt(x.reorderCost) },
  ];
  const out = L.items.filter((i) => i.state === 'out'); const low = L.items.filter((i) => i.state === 'low');
  if (out.length) {
    r.section(`Out of stock - act now (${out.length})`, 'Sorted A-Z. Reorder quantity brings each item up to twice its minimum level.');
    r.table(cols, [...out].sort((a, b) => a.name.localeCompare(b.name)), { totals: { name: `${out.length} products out of stock`, reorderCost: fmt(out.reduce((a, i) => a + i.reorderCost, 0)) } });
  }
  if (low.length) {
    r.section(`Running low - reorder soon (${low.length})`, 'Most urgent first (smallest quantity on hand).');
    r.table(cols, low, { totals: { name: `${low.length} products running low`, reorderCost: fmt(low.reduce((a, i) => a + i.reorderCost, 0)) } });
  }
  r.note('How to use this report', [
    'Reorder quantities are suggestions based on each product\'s minimum level. Adjust to your supplier minimums and sales speed.',
    'Change a product\'s minimum level any time in Products > Inventory so next week\'s report matches how fast it sells.',
  ], 'info');
  return r.finish();
}

/* ============================================================== EXPIRY */
async function buildExpiryPdf(data) {
  const { expiry: E, fmt, tz } = data;
  const r = await Report.create({
    brand: BRAND(), kicker: 'WEEKLY INVENTORY REPORT', title: 'Expiry & Batch Loss Report', tagline: 'Expired stock, what expires this coming week, and the stock value at stake.',
    business: data.business.name, period: `Week ending ${dateText(`${data.sales.period.end}T12:00:00Z`, 'UTC')}`, generated: genText(data),
  });
  const T = E.totals;
  r.kpis([
    { label: 'Already expired', value: fmt(T.expired.costValue), sub: `${T.expired.batches} batch${T.expired.batches === 1 ? '' : 'es'} | ${nf(T.expired.units)} units lost at cost`, tone: T.expired.batches ? 'danger' : 'success' },
    { label: 'Expiring in 7 days', value: fmt(T.thisWeek.costValue), sub: `${T.thisWeek.batches} batch${T.thisWeek.batches === 1 ? '' : 'es'} | ${nf(T.thisWeek.units)} units at risk`, tone: T.thisWeek.batches ? 'warning' : 'success' },
    { label: 'Total stock value at risk', value: fmt(T.atRisk.costValue), sub: `${fmt(T.atRisk.retailValue)} at selling price`, tone: T.atRisk.batches ? 'danger' : 'success' },
    { label: `Watchlist (8-${E.horizon} days)`, value: fmt(T.later.costValue), sub: `${T.later.batches} batch${T.later.batches === 1 ? '' : 'es'} to sell first`, tone: 'info' },
  ]);

  if (!E.expired.length && !E.thisWeek.length && !E.later.length) {
    r.note('No expiry risk', [`No batch is expired or expiring in the next ${E.horizon} days. Keep selling oldest stock first.`], 'success');
    return r.finish();
  }

  r.section('Stock value by expiry window', 'Cost value of the batches in each window');
  r.bars(E.bands.map((b) => ({ label: b.label, value: b.value, tone: b.tone, right: `${fmt(b.value)}  |  ${b.count} batch${b.count === 1 ? '' : 'es'}` })));

  if (E.byBranch.length > 1 || E.bySupplier.length) {
    r.section('Where the loss sits', 'Expired + expiring this week, at cost');
    if (E.byBranch.length) r.table([
      { label: 'Branch', w: 30, key: 'branch', bold: true }, { label: 'Batches', w: 10, align: 'right', get: (x) => nf(x.batches) },
      { label: 'Cost at risk', w: 18, align: 'right', get: (x) => fmt(x.costValue), bold: true }, { label: 'Selling value', w: 18, align: 'right', get: (x) => fmt(x.retailValue) },
    ], E.byBranch.slice(0, 8), { rowH: 18 });
    if (E.bySupplier.length) r.table([
      { label: 'Supplier (possible returns / credit notes)', w: 30, key: 'supplier', bold: true }, { label: 'Batches', w: 10, align: 'right', get: (x) => nf(x.batches) },
      { label: 'Cost at risk', w: 18, align: 'right', get: (x) => fmt(x.costValue), bold: true }, { label: 'Selling value', w: 18, align: 'right', get: (x) => fmt(x.retailValue) },
    ], E.bySupplier, { rowH: 18 });
  }

  const base = [
    { label: 'Product', w: 22, key: 'name', bold: true }, { label: 'SKU', w: 9, key: 'sku' },
    { label: 'Batch', w: 9, key: 'batchNumber' }, { label: 'Branch', w: 10, key: 'branch' }, { label: 'Where', w: 7, key: 'location' },
    { label: 'Qty', w: 5, align: 'right', get: (x) => nf(x.quantity), bold: true },
  ];
  if (E.expired.length) {
    r.section(`Expired stock - write off or return (${E.expired.length})`, 'Biggest loss first. These batches can no longer be sold. Write them off in Batches & expiry, or return to the supplier.');
    r.table([...base,
      { label: 'Expired on', w: 9, get: (x) => dateText(x.expiryDate, tz) },
      { label: 'Overdue', w: 8, chip: (x) => ({ text: `${Math.abs(x.daysLeft)}d ago`, tone: 'danger' }) },
      { label: 'Cost lost', w: 10, align: 'right', get: (x) => fmt(x.costValue), bold: true, color: () => C.danger },
      { label: 'Selling value', w: 10, align: 'right', get: (x) => fmt(x.retailValue) },
    ], E.expired, { totals: { name: `${T.expired.batches} expired batches`, quantity: nf(T.expired.units), costValue: fmt(T.expired.costValue), retailValue: fmt(T.expired.retailValue) }, max: 300 });
  }
  if (E.thisWeek.length) {
    r.section(`Expiring this coming week (${E.thisWeek.length})`, 'Soonest first. Sell these first, discount them, or move them to a busier branch before they are lost.');
    r.table([...base,
      { label: 'Expires on', w: 9, get: (x) => dateText(x.expiryDate, tz) },
      { label: 'Time left', w: 8, chip: (x) => ({ text: x.daysLeft === 0 ? 'TODAY' : `${x.daysLeft} day${x.daysLeft === 1 ? '' : 's'}`, tone: x.daysLeft <= 2 ? 'danger' : 'warning' }) },
      { label: 'Cost at risk', w: 10, align: 'right', get: (x) => fmt(x.costValue), bold: true, color: () => C.warn },
      { label: 'Selling value', w: 10, align: 'right', get: (x) => fmt(x.retailValue) },
    ], E.thisWeek, { totals: { name: `${T.thisWeek.batches} batches expiring`, quantity: nf(T.thisWeek.units), costValue: fmt(T.thisWeek.costValue), retailValue: fmt(T.thisWeek.retailValue) }, max: 300 });
  }
  if (E.later.length) {
    r.section(`Watchlist: next ${E.horizon} days (${E.later.length})`, 'Not urgent yet. Plan promotions and sell the oldest batch first.');
    r.table([
      { label: 'Product', w: 26, key: 'name', bold: true }, { label: 'Batch', w: 10, key: 'batchNumber' }, { label: 'Branch', w: 12, key: 'branch' },
      { label: 'Qty', w: 6, align: 'right', get: (x) => nf(x.quantity) }, { label: 'Expires on', w: 11, get: (x) => dateText(x.expiryDate, tz) },
      { label: 'Days left', w: 8, chip: (x) => ({ text: `${x.daysLeft} days`, tone: x.daysLeft <= 14 ? 'warning' : 'info' }) },
      { label: 'Cost value', w: 11, align: 'right', get: (x) => fmt(x.costValue), bold: true },
    ], E.later, { max: 150, rowH: 18 });
  }
  r.note('Recommended actions', [
    '1.  Write off expired batches in Batches & expiry so your stock value and profit reports stay accurate.',
    '2.  Return supplier-eligible stock for credit before the date passes; ask for a credit note.',
    '3.  Discount or bundle anything in the "expiring this coming week" list, and sell the oldest batch first.',
    E.truncated ? 'Note: the list was capped at 5,000 batches. Open Batches & expiry for the complete picture.' : 'Values are at cost price unless marked "selling value". This report only reads your data; it never changes stock.',
  ], 'warning');
  return r.finish();
}

module.exports = { buildLowStockPdf, buildExpiryPdf, rangeText };
