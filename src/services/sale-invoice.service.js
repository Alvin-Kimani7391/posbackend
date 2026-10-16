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
const { formatMoney, amountInWords: amountInWordsI18n } = require('../utils/currency');
const { t } = require('../i18n');
const { buildContext } = require('../utils/businessContext');
const { normalizeLanguage } = require('../constants/countries');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, cur = 'KES', lang = 'en') => formatMoney(cents, cur, { lang }); // KES 1,250.50  |  TZS 15,000
const num = (n) => (Math.round((Number(n) || 0) * 1000) / 1000).toString();
const dateFmt = (d, tz) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz || 'Africa/Nairobi' }) : '');

/** 125050 cents -> "One thousand two hundred and fifty Kenya Shillings and fifty cents only" (Swahili for lang='sw'). */
const amountInWords = (cents, cur = 'KES', lang = 'en') => amountInWordsI18n(cents, cur, lang);

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

function renderInvoiceHtml(d, { copy = 'ORIGINAL', paper = 'A4', autoPrint = false, lang: langOpt } = {}) {
  const { sale, business: b, branch, customer, warehouse, payments, cashier } = d;
  const ctx = buildContext(b);                       // country / currency / language of THIS business
  const lang = normalizeLanguage(langOpt, ctx.language);
  const L = (key, params) => t(lang, `invoice.${key}`, params);
  const cur = ctx.currency;
  const tz = b.timezone || ctx.timezone;
  const m = (c) => money(c, cur, lang);
  const vatReg = !!b.vatRegistered;
  const title = vatReg ? L('taxInvoice') : L('invoice');
  const statusKey = sale.saleStatus && sale.saleStatus !== 'COMPLETED' ? null : (sale.balance > 0 ? (sale.amountPaid > 0 ? 'PART PAID' : 'UNPAID') : 'PAID');
  const status = statusKey ? ({ PAID: L('statusPaid'), 'PART PAID': L('statusPart'), UNPAID: L('statusUnpaid') })[statusKey] : sale.saleStatus;
  const stampClass = statusKey === 'PAID' ? 'paid' : statusKey === 'PART PAID' ? 'part' : 'due';
  const bs = b.receiptSettings || {};
  const taxId = b.kraPin || b.taxPin;                 // KRA PIN (Kenya) / TIN (Tanzania)
  const taxIdLabel = ctx.country.taxIdLabel[lang];
  const vrnLine = b.vrn ? `<div>VRN: <strong>${esc(b.vrn)}</strong></div>` : '';

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

  const payRows = (payments || []).map((p) => `<tr><td>${esc(p.provider && p.method === 'MOBILE_MONEY' ? p.provider : p.method)}${p.reference ? ` <span class="muted">${esc(p.reference)}</span>` : ''}</td><td class="r">${m(p.amount)}</td></tr>`).join('');
  const issuedFrom = warehouse ? `${L('warehouse')}: ${esc(warehouse.name)}` : (branch ? `${L('branch')}: ${esc(branch.name)}` : '');
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

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} ${esc(sale.invoiceNumber || sale.receiptNumber)}</title><style>${css}</style></head><body>
<div class="actions"><button onclick="window.print()">${esc(L('print'))}</button></div>
<div class="page">
  <div class="stamp ${stampClass}">${esc(status)}</div>
  <div class="top">
    <div class="biz">
      ${b.logo && /^https?:\/\//i.test(b.logo) && bs.showLogo !== false ? `<img src="${esc(b.logo)}" alt="" style="max-height:54px;max-width:160px;margin-bottom:4px">` : ''}
      <h1>${esc(b.legalName || b.name)}</h1>
      <div>${esc(addr)}</div><div>${L('tel')}: ${esc(branch?.phone || b.phone || '')}${b.email ? ` &nbsp; ${L('email')}: ${esc(b.email)}` : ''}</div>
      ${taxId ? `<div>${esc(taxIdLabel)}: <strong>${esc(taxId)}</strong></div>` : ''}${vrnLine}
    </div>
    <div class="doc"><h2>${title}</h2><div>${L('no')}: <strong>${esc(sale.invoiceNumber || sale.receiptNumber)}</strong></div>
      <div>${L('date')}: ${esc(dateFmt(sale.soldAt || sale.createdAt, tz))}</div>${sale.dueDate ? `<div>${L('due')}: <strong>${esc(dateFmt(sale.dueDate, tz))}</strong></div>` : ''}
      <div class="copy">${esc(copy)}</div></div>
  </div>
  <div class="meta">
    <div class="box"><h3>${esc(L('billTo'))}</h3>${customer ? `<strong>${esc(customer.name)}</strong><br>${esc(customer.phone || '')}${customer.address ? `<br>${esc(customer.address)}` : ''}${customer.kraPin ? `<br>${esc(taxIdLabel)}: ${esc(customer.kraPin)}` : ''}` : L('walkIn')}</div>
    <div class="box"><h3>${esc(L('details'))}</h3>${esc(sale.channel === 'WHOLESALE' ? L('wholesaleSale') : L('retailSale'))}<br>${issuedFrom}<br>${L('receipt')}: ${esc(sale.receiptNumber)}<br>${L('servedBy')}: ${esc(cashier?.name || '')}</div>
  </div>
  <table><thead><tr><th class="c" style="width:28px">#</th><th>${esc(L('description'))}</th><th class="c">${esc(L('qtyUnit'))}</th><th class="r">${esc(L('unitPrice'))}</th><th class="r">${esc(L('discount'))}</th><th class="c">${esc(L('vat'))}</th><th class="r">${esc(L('amount'))}</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="bottom">
    <div class="left">
      ${payRows ? `<table><thead><tr><th>${esc(L('paymentsReceived'))}</th><th class="r">${esc(L('amount'))}</th></tr></thead><tbody>${payRows}</tbody></table>` : ''}
      <div class="words"><strong>${esc(L('amountInWords'))}:</strong> ${esc(amountInWords(sale.total, cur, lang))}</div>
      ${sale.notes ? `<div style="margin-top:8px"><strong>${esc(L('notes'))}:</strong> ${esc(sale.notes)}</div>` : ''}
      ${d.tillNumber && ctx.country.integrations.mpesaPayhero ? `<div style="margin-top:8px"><strong>${esc(L('payViaTill'))}:</strong> ${esc(d.tillNumber)}</div>` : ''}
    </div>
    <div class="right"><table class="tot">
      <tr><td>${esc(L('subtotal'))}</td><td class="r">${m(sale.subtotal)}</td></tr>
      ${sale.itemDiscount ? `<tr><td>${esc(L('itemDiscounts'))}</td><td class="r">- ${m(sale.itemDiscount)}</td></tr>` : ''}
      ${sale.cartDiscount ? `<tr><td>${esc(L('discountLine'))}</td><td class="r">- ${m(sale.cartDiscount)}</td></tr>` : ''}
      <tr><td>${esc(L('vat'))}${b.taxSettings?.taxInclusive ? L('vatIncluded') : ''}</td><td class="r">${m(sale.tax)}</td></tr>
      <tr class="grand"><td>${esc(L('total'))}</td><td class="r">${m(sale.total)}</td></tr>
      <tr><td>${esc(L('paid'))}</td><td class="r">${m(sale.amountPaid)}</td></tr>
      <tr><td><strong>${esc(L('balanceDue'))}</strong></td><td class="r"><strong>${m(sale.balance)}</strong></td></tr>
    </table></div>
  </div>
  <div class="sign"><div>${esc(L('preparedBy'))}</div><div>${esc(L('deliveredBy'))}</div><div>${esc(L('receivedBy'))}</div></div>
  <div class="foot">${esc(bs.footerMessage && bs.footerMessage !== 'Thank you for your business!' ? bs.footerMessage : L('thanks'))}${(bs.customLines || []).map((l) => `<br>${esc(l)}`).join('')}<br>${esc(L('goodsRemain', { name: b.name }))}</div>
</div>
${autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''}
</body></html>`;
}

/** JSON version (decimal major units of the business currency) for apps that draw the invoice themselves. */
function toJson(d, { lang: langOpt } = {}) {
  const { sale, business, branch, customer, warehouse, payments } = d;
  const ctx = buildContext(business);
  const lang = normalizeLanguage(langOpt, ctx.language);
  const k = (c) => Math.round(Number(c) || 0) / 100;
  return {
    invoiceNumber: sale.invoiceNumber, receiptNumber: sale.receiptNumber, date: sale.soldAt || sale.createdAt, dueDate: sale.dueDate || null,
    status: sale.balance > 0 ? (sale.amountPaid > 0 ? 'PART_PAID' : 'UNPAID') : 'PAID', channel: sale.channel || 'RETAIL',
    business: { name: business.name, address: business.address, phone: business.phone, taxId: business.kraPin || business.taxPin, taxIdLabel: ctx.country.taxIdLabel[lang], kraPin: business.kraPin || business.taxPin, vrn: business.vrn || null, currency: ctx.currency, country: ctx.countryCode, language: lang },
    branch: branch ? { name: branch.name, phone: branch.phone } : null, warehouse: warehouse ? { name: warehouse.name, code: warehouse.code } : null,
    customer: customer ? { name: customer.name, phone: customer.phone, address: customer.address } : null,
    items: (sale.items || []).map((i) => ({ name: i.nameSnapshot, sku: i.skuSnapshot, quantity: i.quantity, unit: i.unitName || null, unitFactor: i.unitFactor || 1, baseQuantity: i.baseQuantity || i.quantity, unitPrice: k(i.unitPrice), discount: k(i.discount), taxRate: i.taxRate, taxAmount: k(i.taxAmount), total: k(i.total) })),
    subtotal: k(sale.subtotal), itemDiscount: k(sale.itemDiscount), cartDiscount: k(sale.cartDiscount), tax: k(sale.tax), total: k(sale.total), amountPaid: k(sale.amountPaid), balance: k(sale.balance),
    amountInWords: amountInWords(sale.total, ctx.currency, lang),
    payments: (payments || []).map((p) => ({ method: p.method, provider: p.provider || null, reference: p.reference, amount: k(p.amount) })),
  };
}

module.exports = { getInvoiceData, renderInvoiceHtml, toJson, amountInWords };
