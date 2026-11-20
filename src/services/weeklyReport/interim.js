'use strict';
/**
 * weeklyReport/interim.js - the INTERIM report for every schedule slot that is not Saturday.
 * Saturday stays the normal weekly report. An interim report covers exactly what the previous report did not:
 *   from where the last report stopped (weekly: Saturday 00:00 of its send day; interim: the moment it was sent)
 *   up to the moment this one is sent. It says so in plain words at the top of the email and on the PDFs.
 * Sales + out of stock / low stock + expiry (same two PDFs as the weekly report).
 */
const Sale = require('../../models/Sale');
const Business = require('../../models/Business');
const mongoose = require('mongoose');
const { getBusinessContext } = require('../../utils/businessContext');
const { lowStockSection, expirySection, localDate } = require('./data');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const INK = '#14213d'; const MUTE = '#64748b'; const LINE = '#e5e9ef'; const TEAL = '#0f766e'; const BAD = '#dc2626'; const WARN = '#b45309';
const FONT = "'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";

/** "Saturday 14 Nov 2026" or "Sunday 15 Nov 2026, 10:00" */
function point(ms, tz, withTime) {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(ms));
  if (!withTime) return d;
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return `${d}, ${t}`;
}
const isMidnight = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)) === '00:00';

async function salesBetween(businessId, tz, fromMs, toMs) {
  const base = { businessId: oid(businessId), saleStatus: 'COMPLETED', soldAt: { $gte: new Date(fromMs), $lt: new Date(toMs) } };
  const dayExpr = { $dateToString: { format: '%Y-%m-%d', date: '$soldAt', timezone: tz } };
  const [tot, byDay, items, top] = await Promise.all([
    Sale.aggregate([{ $match: base }, { $group: { _id: null, revenue: { $sum: '$total' }, tx: { $sum: 1 } } }]),
    Sale.aggregate([{ $match: base }, { $group: { _id: dayExpr, revenue: { $sum: '$total' }, tx: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
    Sale.aggregate([{ $match: base }, { $unwind: '$items' }, { $group: { _id: null,
      units: { $sum: { $ifNull: ['$items.baseQuantity', '$items.quantity'] } },
      profit: { $sum: { $subtract: [{ $subtract: ['$items.total', { $ifNull: ['$items.taxAmount', 0] }] }, { $multiply: ['$items.costPriceSnapshot', '$items.quantity'] }] } } } }]),
    Sale.aggregate([{ $match: base }, { $unwind: '$items' }, { $group: { _id: '$items.nameSnapshot', units: { $sum: { $ifNull: ['$items.baseQuantity', '$items.quantity'] } }, revenue: { $sum: '$items.total' } } }, { $sort: { revenue: -1 } }, { $limit: 8 }]),
  ]);
  const t = tot[0] || { revenue: 0, tx: 0 }; const i = items[0] || { units: 0, profit: 0 };
  return { revenue: t.revenue, tx: t.tx, avgBasket: t.tx ? Math.round(t.revenue / t.tx) : 0, units: Math.round(i.units * 100) / 100, profit: Math.round(i.profit || 0),
    byDay: byDay.map((d) => ({ date: d._id, revenue: d.revenue, tx: d.tx })), top: top.map((p) => ({ name: p._id, units: Math.round(p.units * 100) / 100, revenue: p.revenue })) };
}

/** Everything for one business between fromMs and toMs. Shaped like collect() so the two PDF builders work unchanged. */
async function collectInterim(businessId, { fromMs, toMs }) {
  const business = await Business.findById(businessId).select('name email phone address town county').lean();
  if (!business) throw new Error('Business not found');
  const ctx = await getBusinessContext(businessId);
  const tz = ctx.timezone || 'Africa/Nairobi';
  const today = localDate(toMs, tz);
  const [sales, lowStock, expiry] = await Promise.all([salesBetween(businessId, tz, fromMs, toMs), lowStockSection(businessId), expirySection(businessId, tz, today)]);
  const label = `${point(fromMs, tz, !isMidnight(fromMs, tz))} to ${point(toMs, tz, true)}`;
  return {
    business: { id: String(business._id), name: business.name, email: business.email, phone: business.phone, address: [business.address, business.town, business.county].filter(Boolean).join(', ') },
    currency: ctx.currency, fmt: ctx.fmt, tz, generatedAt: new Date(toMs), today, periodLabel: label,
    sales: { ...sales, period: { start: localDate(fromMs, tz), end: today }, hasSales: sales.tx > 0 },
    lowStock, expiry, interim: { fromMs, toMs, label },
  };
}

function buildInterimEmail(data, { demo = false } = {}) {
  const { sales: S, lowStock: L, expiry: E, fmt, business, interim } = data;
  const kpi = (k, v) => `<td width="25%" valign="top" style="padding:6px"><div style="border:1px solid ${LINE};border-radius:8px;padding:12px"><div style="font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:${MUTE};font-weight:700">${k}</div><div style="font-size:19px;font-weight:700;color:${INK};margin-top:4px">${esc(v)}</div></div></td>`;
  const tbl = (head, rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;font-size:13px;color:${INK}"><tr>${head.map((h, i) => `<td align="${i ? 'right' : 'left'}" style="padding:6px 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;color:#94a3b8;font-weight:700">${h}</td>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td align="${i ? 'right' : 'left'}" style="padding:7px 8px;border-top:1px solid ${LINE}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
  const h = (t, sub) => `<div style="margin-top:24px;font-size:16px;font-weight:700;color:${INK}">${t}</div>${sub ? `<div style="font-size:12.5px;color:${MUTE};margin-top:2px">${sub}</div>` : ''}`;
  const outItems = L.items.filter((i) => i.state === 'out');
  const lowItems = L.items.filter((i) => i.state === 'low');
  const expList = [...E.expired, ...E.thisWeek].slice(0, 15);
  const dayName = (ds) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ds}T12:00:00Z`));

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Report - ${esc(business.name)}</title></head>
<body style="margin:0;padding:0;background:#eef2f6;font-family:${FONT}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0b1f33;padding:18px 24px;color:#fff"><div style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;color:#9fb3c8">Interim business report</div><div style="font-size:20px;font-weight:700;margin-top:4px">${esc(business.name)}</div></td></tr>
<tr><td style="padding:22px 24px 8px">
  <div style="border-left:4px solid ${TEAL};background:#f0fdfa;border-radius:0 8px 8px 0;padding:12px 14px;font-size:14px;line-height:1.6;color:${INK}"><strong>This report covers</strong><br>${esc(interim.label)}<div style="font-size:12px;color:${MUTE};margin-top:4px">It picks up where the previous report stopped. The full weekly report still arrives every Saturday.</div></div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr>${kpi('Total sales', fmt(S.revenue))}${kpi('Transactions', String(S.tx))}${kpi('Avg. basket', fmt(S.avgBasket))}${kpi('Gross profit', fmt(S.profit))}</tr></table>
  ${S.byDay.length ? h('Sales by day') + tbl(['Day', 'Sales', 'Receipts'], S.byDay.map((d) => [esc(dayName(d.date)), esc(fmt(d.revenue)), String(d.tx)])) : `<div style="margin-top:16px;font-size:13px;color:${MUTE}">No sales were recorded in this period.</div>`}
  ${S.top.length ? h('Top products') + tbl(['Product', 'Units', 'Sales'], S.top.map((p) => [esc(p.name), String(p.units), esc(fmt(p.revenue))])) : ''}
  ${h(`Out of stock <span style="color:${BAD}">(${L.outCount})</span>`, L.lowCount ? `${L.lowCount} more running low. Full list in the attached Low Stock Report.` : 'Full list in the attached Low Stock Report.')}
  ${outItems.length ? tbl(['Product', 'Branch', 'Restock cost'], outItems.slice(0, 25).map((i) => [esc(i.name), esc(i.branch), esc(fmt(i.reorderCost))])) + (outItems.length > 25 ? `<div style="font-size:12px;color:${MUTE};margin-top:6px">+ ${outItems.length - 25} more in the PDF</div>` : '') : `<div style="font-size:13px;color:${MUTE};margin-top:8px">Nothing is out of stock.</div>`}
  ${lowItems.length ? h(`Running low <span style="color:${WARN}">(${lowItems.length})</span>`) + tbl(['Product', 'Branch', 'Left'], lowItems.slice(0, 10).map((i) => [esc(i.name), esc(i.branch), String(i.quantity)])) : ''}
  ${h('Expiry watch', 'Expired and expiring within 7 days. Full list in the attached Expiry Report.')}
  ${expList.length ? tbl(['Product / batch', 'Qty', 'Expiry'], expList.map((r) => [`${esc(r.name)}${r.batchNumber ? ` <span style="color:${MUTE}">(${esc(r.batchNumber)})</span>` : ''}`, String(r.quantity), r.daysLeft < 0 ? `<span style="color:${BAD}">expired</span>` : `in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`])) : `<div style="font-size:13px;color:${MUTE};margin-top:8px">No expired batches, none expiring this week.</div>`}
</td></tr>
<tr><td style="padding:18px 24px 24px;font-size:12px;line-height:1.7;color:${MUTE}">Sent to the owner and managers of <strong style="color:${INK}">${esc(business.name)}</strong>. Sales exclude cancelled sales. Gross profit is sales before tax minus the cost price recorded at the time of sale.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${business.name} - interim report`, `Covers: ${interim.label}`, '',
    `Total sales: ${fmt(S.revenue)} (${S.tx} sales), gross profit ${fmt(S.profit)}`, '',
    ...(S.byDay.length ? ['Sales by day:', ...S.byDay.map((d) => `  ${dayName(d.date)}: ${fmt(d.revenue)} (${d.tx} sales)`), ''] : []),
    `Out of stock: ${L.outCount}${outItems.length ? ` - ${outItems.slice(0, 15).map((i) => i.name).join(', ')}` : ''}`,
    `Running low: ${L.lowCount}`,
    `Expiry: ${E.totals.expired.batches} expired, ${E.totals.thisWeek.batches} expiring within 7 days.`, '',
    'The two PDFs attached have the full lists.',
  ].join('\n');
  const subject = `${demo ? '[DEMO] ' : ''}${business.name}: report ${interim.label} - ${fmt(S.revenue)} in sales`;
  return { html, text, subject };
}

module.exports = { collectInterim, buildInterimEmail, point };
