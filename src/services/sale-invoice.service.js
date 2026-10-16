'use strict';
/**
 * sale-invoice.service.js - a PRINTABLE sales invoice (A4 / A5 HTML with print styles; "Save as PDF" works from any
 * browser's print dialog) for any sale, built for wholesale: unit breakdown (3 bundle x 24), discounts, VAT, payments,
 * balance due with due date, amount in words, signature boxes and an ORIGINAL / DUPLICATE label.
 * Everything is read from the stored sale, so re-printing an old invoice never changes it.
 */
const Sale = require('../models/Sale');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const Customer = require('../models/Customer');
const Warehouse = require('../models/Warehouse');
const Payment = require('../models/Payment');
const User = require('../models/User');
const IntegrationSettings = require('../models/IntegrationSettings');
const ApiError = require('../utils/ApiError');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'KES') => `${cur} ${(Math.round(Number(cents) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => (Math.round((Number(n) || 0) * 1000) / 1000).toString();
const dateFmt = (d, tz) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz || 'Africa/Nairobi' }) : '');

const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function below1000(n) {
  const out = [];
  if (n >= 100) { out.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; if (n) out.push('and'); }
  if (n >= 20) { out.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')); } else if (n > 0) out.push(ONES[n]);
  return out.join(' ');
}
function wordsInt(n) {
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, label] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= size) { parts.push(`${below1000(Math.floor(n / size))} ${label}`); n %= size; }
  }
  if (n > 0) parts.push(n < 100 && parts.length ? `and ${below1000(n)}` : below1000(n));
  return parts.join(' ');
}
/** 125050 cents -> "One hundred and twenty-five Kenya Shillings and fifty cents only" */
function amountInWords(cents, cur = 'KES') {
  const total = Math.max(0, Math.round(Number(cents) || 0));
  const whole = Math.floor(total / 100); const c = total % 100;
  const name = cur === 'KES' ? (whole === 1 ? 'Kenya Shilling' : 'Kenya Shillings') : cur;
  let s = `${wordsInt(whole)} ${name}`;
  if (c) s += ` and ${wordsInt(c)} cents`;
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} only`;
}

async function getInvoiceData(businessId, saleId) {
  const sale = await Sale.findOne({ _id: saleId, businessId }).lean();
  if (!sale) throw ApiError.notFound('Sale not found');
  const [business, branch, customer, warehouse, payments, cashier, integ] = await Promise.all([
    Business.findById(businessId).lean(),
    Branch.findOne({ _id: sale.branchId, businessId }).lean(),
    sale.customerId ? Customer.findOne({ _id: sale.customerId, businessId }).lean() : null,
    sale.warehouseId ? Warehouse.findOne({ _id: sale.warehouseId, businessId }).lean() : null,
    Payment.find({ saleId: sale._id, status: 'SUCCESS' }).sort({ createdAt: 1 }).lean(),
    User.findById(sale.cashierId).select('name').lean(),
    IntegrationSettings.findOne({ businessId }).select('mpesa.tillNumber').lean(),
  ]);
  return { sale, business: business || {}, branch, customer, warehouse, payments, cashier, tillNumber: integ?.mpesa?.tillNumber || null };
}

function renderInvoiceHtml(d, { copy = 'ORIGINAL', paper = 'A4', autoPrint = false } = {}) {
  const { sale, business: b, branch, customer, warehouse, payments, cashier } = d;
  const cur = b.currency || 'KES';
  const tz = b.timezone;
  const m = (c) => money(c, cur);
  const vatReg = !!b.vatRegistered;
  const title = vatReg ? 'TAX INVOICE' : 'INVOICE';
  const status = sale.saleStatus && sale.saleStatus !== 'COMPLETED' ? sale.saleStatus : (sale.balance > 0 ? (sale.amountPaid > 0 ? 'PART PAID' : 'UNPAID') : 'PAID');
  const stampClass = status === 'PAID' ? 'paid' : status === 'PART PAID' ? 'part' : 'due';
  const bs = b.receiptSettings || {};
  const kra = b.kraPin || b.taxPin;

  const rows = (sale.items || []).map((i, idx) => {
    const unitLabel = i.unitName ? `${esc(i.unitName)}${i.unitFactor > 1 ? ` <span class="muted">(x${num(i.unitFactor)})</span>` : ''}` : '';
    const lineBase = i.baseQuantity && i.unitFactor > 1 ? `<div class="muted">= ${num(i.baseQuantity)} pcs</div>` : '';
    const serials = i.serialNumbers && i.serialNumbers.length ? `<div class="muted">S/N: ${esc(i.serialNumbers.join(', '))}</div>` : '';
    const batch = i.batchAllocations && i.batchAllocations.length ? `<div class="muted">Batch: ${esc(i.batchAllocations.map((a) => a.batchNumber).join(', '))}</div>` : '';
    return `<tr>
      <td class="c">${idx + 1}</td>
      <td><strong>${esc(i.nameSnapshot)}</strong><div class="muted">${esc(i.skuSnapshot || '')}</div>${lineBase}${serials}${batch}</td>
      <td class="c">${num(i.quantity)} ${unitLabel}</td>
      <td class="r">${m(i.unitPrice)}</td>
      <td class="r">${i.discount ? m(i.discount) : '-'}</td>
      <td class="c">${i.taxRate ? `${num(i.taxRate)}%` : '-'}</td>
      <td class="r"><strong>${m(i.total)}</strong></td>
    </tr>`;
  }).join('');

  const payRows = (payments || []).map((p) => `<tr><td>${esc(p.method)}${p.reference ? ` <span class="muted">${esc(p.reference)}</span>` : ''}</td><td class="r">${m(p.amount)}</td></tr>`).join('');
  const issuedFrom = warehouse ? `Warehouse: ${esc(warehouse.name)}` : (branch ? `Branch: ${esc(branch.name)}` : '');
  const addr = [b.address, b.town, b.county].filter(Boolean).join(', ');
  const css = `
    @page { size: ${paper === 'A5' ? 'A5' : 'A4'}; margin: 12mm; }
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:12px;margin:0;background:#f3f4f6}
    .page{max-width:${paper === 'A5' ? '148mm' : '210mm'};margin:12px auto;background:#fff;padding:18px 22px;position:relative}
    .top{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:10px}
    .biz h1{margin:0 0 4px;font-size:20px} .biz div{line-height:1.45}
    .doc{text-align:right} .doc h2{margin:0;font-size:22px;letter-spacing:1px} .copy{display:inline-block;border:1px solid #111;padding:1px 8px;margin-top:4px;font-size:10px;font-weight:bold}
    .meta{display:flex;gap:16px;margin:12px 0} .box{flex:1;border:1px solid #cbd5e1;border-radius:4px;padding:8px 10px;line-height:1.5}
    .box h3{margin:0 0 4px;font-size:10px;text-transform:uppercase;color:#475569;letter-spacing:.5px}
    table{width:100%;border-collapse:collapse} th{background:#111;color:#fff;font-size:11px;text-align:left;padding:6px}
    td{padding:6px;border-bottom:1px solid #e2e8f0;vertical-align:top} .r{text-align:right} .c{text-align:center} .muted{color:#64748b;font-size:10px}
    .bottom{display:flex;gap:16px;margin-top:12px} .bottom .left{flex:1.2} .bottom .right{flex:1}
    .tot td{border:0;padding:3px 6px} .tot .grand td{border-top:2px solid #111;font-size:14px;font-weight:bold;padding-top:6px}
    .words{margin-top:8px;font-style:italic} .stamp{position:absolute;right:30px;top:120px;transform:rotate(-12deg);font-size:26px;font-weight:bold;border:3px solid;padding:2px 14px;opacity:.28}
    .stamp.paid{color:#15803d;border-color:#15803d} .stamp.part{color:#b45309;border-color:#b45309} .stamp.due{color:#b91c1c;border-color:#b91c1c}
    .sign{display:flex;gap:30px;margin-top:34px} .sign div{flex:1;border-top:1px solid #111;padding-top:4px;font-size:10px;color:#475569}
    .foot{margin-top:14px;text-align:center;color:#475569;font-size:10px} .actions{max-width:210mm;margin:10px auto;text-align:right}
    .actions button{padding:8px 16px;font-size:13px;cursor:pointer}
    @media print{body{background:#fff}.page{margin:0;padding:0;max-width:none}.actions{display:none}}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} ${esc(sale.invoiceNumber || sale.receiptNumber)}</title><style>${css}</style></head><body>
<div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div>
<div class="page">
  <div class="stamp ${stampClass}">${esc(status)}</div>
  <div class="top">
    <div class="biz">
      ${b.logo && /^https?:\/\//i.test(b.logo) && bs.showLogo !== false ? `<img src="${esc(b.logo)}" alt="" style="max-height:54px;max-width:160px;margin-bottom:4px">` : ''}
      <h1>${esc(b.legalName || b.name)}</h1>
      <div>${esc(addr)}</div><div>Tel: ${esc(branch?.phone || b.phone || '')}${b.email ? ` &nbsp; Email: ${esc(b.email)}` : ''}</div>
      ${kra ? `<div>KRA PIN: <strong>${esc(kra)}</strong></div>` : ''}
    </div>
    <div class="doc"><h2>${title}</h2><div>No: <strong>${esc(sale.invoiceNumber || sale.receiptNumber)}</strong></div>
      <div>Date: ${esc(dateFmt(sale.soldAt || sale.createdAt, tz))}</div>${sale.dueDate ? `<div>Due: <strong>${esc(dateFmt(sale.dueDate, tz))}</strong></div>` : ''}
      <div class="copy">${esc(copy)}</div></div>
  </div>
  <div class="meta">
    <div class="box"><h3>Bill to</h3>${customer ? `<strong>${esc(customer.name)}</strong><br>${esc(customer.phone || '')}${customer.address ? `<br>${esc(customer.address)}` : ''}${customer.kraPin ? `<br>KRA PIN: ${esc(customer.kraPin)}` : ''}` : 'Walk-in customer'}</div>
    <div class="box"><h3>Details</h3>${esc(sale.channel === 'WHOLESALE' ? 'Wholesale sale' : 'Retail sale')}<br>${issuedFrom}<br>Receipt: ${esc(sale.receiptNumber)}<br>Served by: ${esc(cashier?.name || '')}</div>
  </div>
  <table><thead><tr><th class="c" style="width:28px">#</th><th>Description</th><th class="c">Qty / Unit</th><th class="r">Unit price</th><th class="r">Discount</th><th class="c">VAT</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom">
    <div class="left">
      ${payRows ? `<table><thead><tr><th>Payments received</th><th class="r">Amount</th></tr></thead><tbody>${payRows}</tbody></table>` : ''}
      <div class="words"><strong>Amount in words:</strong> ${esc(amountInWords(sale.total, cur))}</div>
      ${sale.notes ? `<div style="margin-top:8px"><strong>Notes:</strong> ${esc(sale.notes)}</div>` : ''}
      ${d.tillNumber ? `<div style="margin-top:8px"><strong>Pay via M-PESA Till:</strong> ${esc(d.tillNumber)}</div>` : ''}
    </div>
    <div class="right"><table class="tot">
      <tr><td>Subtotal</td><td class="r">${m(sale.subtotal)}</td></tr>
      ${sale.itemDiscount ? `<tr><td>Item discounts</td><td class="r">- ${m(sale.itemDiscount)}</td></tr>` : ''}
      ${sale.cartDiscount ? `<tr><td>Discount</td><td class="r">- ${m(sale.cartDiscount)}</td></tr>` : ''}
      <tr><td>VAT${b.taxSettings?.taxInclusive ? ' (included)' : ''}</td><td class="r">${m(sale.tax)}</td></tr>
      <tr class="grand"><td>TOTAL</td><td class="r">${m(sale.total)}</td></tr>
      <tr><td>Paid</td><td class="r">${m(sale.amountPaid)}</td></tr>
      <tr><td><strong>Balance due</strong></td><td class="r"><strong>${m(sale.balance)}</strong></td></tr>
    </table></div>
  </div>
  <div class="sign"><div>Prepared by</div><div>Delivered by</div><div>Received by (name, signature, date)</div></div>
  <div class="foot">${esc(bs.footerMessage || 'Thank you for your business!')}${(bs.customLines || []).map((l) => `<br>${esc(l)}`).join('')}<br>Goods remain the property of ${esc(b.name)} until paid in full.</div>
</div>
${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''}
</body></html>`;
}

/** JSON version (KES decimals) for apps that draw the invoice themselves. */
function toJson(d) {
  const { sale, business, branch, customer, warehouse, payments } = d;
  const k = (c) => Math.round(Number(c) || 0) / 100;
  return {
    invoiceNumber: sale.invoiceNumber, receiptNumber: sale.receiptNumber, date: sale.soldAt || sale.createdAt, dueDate: sale.dueDate || null,
    status: sale.balance > 0 ? (sale.amountPaid > 0 ? 'PART_PAID' : 'UNPAID') : 'PAID', channel: sale.channel || 'RETAIL',
    business: { name: business.name, address: business.address, phone: business.phone, kraPin: business.kraPin || business.taxPin, currency: business.currency || 'KES' },
    branch: branch ? { name: branch.name, phone: branch.phone } : null, warehouse: warehouse ? { name: warehouse.name, code: warehouse.code } : null,
    customer: customer ? { name: customer.name, phone: customer.phone, address: customer.address } : null,
    items: (sale.items || []).map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unit: i.unitName || null, unitFactor: i.unitFactor || 1, baseQuantity: i.baseQuantity || i.quantity, unitPrice: k(i.unitPrice), discount: k(i.discount), taxRate: i.taxRate, taxAmount: k(i.taxAmount), total: k(i.total) })),
    subtotal: k(sale.subtotal), itemDiscount: k(sale.itemDiscount), cartDiscount: k(sale.cartDiscount), tax: k(sale.tax), total: k(sale.total), amountPaid: k(sale.amountPaid), balance: k(sale.balance),
    amountInWords: amountInWords(sale.total, business.currency || 'KES'),
    payments: (payments || []).map((p) => ({ method: p.method, reference: p.reference, amount: k(p.amount) })),
  };
}

module.exports = { getInvoiceData, renderInvoiceHtml, toJson, amountInWords };
