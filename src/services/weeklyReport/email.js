'use strict';
/** weeklyReport/email.js - the weekly performance email (HTML + plain text). Table layout, inline styles, mobile friendly. */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif";
const A = '#0f766e'; const B = '#14b8a6'; const DK = '#064e3b';
const GOOD = '#15803d'; const BAD = '#dc2626'; const WARN = '#d97706';
const APP = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const brand = () => process.env.BREVO_SENDER_NAME || 'Six Star POS';
const supportEmail = () => process.env.SUPPORT_EMAIL || 'info@sixstartechnologies.com';
const supportPhone = () => process.env.SUPPORT_PHONE || '0 111 976 842';

const long = (ds) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ds}T12:00:00Z`));
const longY = (ds) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ds}T12:00:00Z`));
const nf = (n) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });

/** +12.4% / -3% / "new" pill. invert=true when "down" is good (not used yet). */
function pill(change, { big = false } = {}) {
  const fs = big ? 13 : 11;
  if (change === null) return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:#dbeafe;color:#1d4ed8;font-size:${fs}px;font-weight:700">New</span>`;
  if (change === 0) return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:${fs}px;font-weight:700">&ndash; 0%</span>`;
  const up = change > 0;
  return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;background:${up ? '#dcfce7' : '#fee2e2'};color:${up ? GOOD : BAD};font-size:${fs}px;font-weight:700">${up ? '&#9650;' : '&#9660;'} ${Math.abs(change).toFixed(Math.abs(change) >= 100 ? 0 : 1)}%</span>`;
}
const changeText = (c) => (c === null ? 'new' : `${c > 0 ? '+' : ''}${c}%`);

function build(data, { demo = false } = {}) {
  const { sales: S, lowStock: L, expiry: E, fmt, business } = data;
  const cur = S.thisWeek; const url = APP();
  const cta = (label, href, primary) => (href ? `<a href="${esc(href)}" target="_blank" style="display:inline-block;margin:4px 5px;padding:13px 26px;border-radius:12px;font-family:${FONT};font-size:14px;font-weight:700;text-decoration:none;${primary ? `background:${A};background-image:linear-gradient(135deg,${A},${B});color:#ffffff` : `background:#ffffff;color:${A};border:2px solid #a7f3d0`}">${esc(label)}</a>` : '');

  const headline = S.change.revenue === null ? 'A new week of sales' : S.change.revenue >= 0 ? 'Sales are up on last week' : 'Sales are down on last week';
  const maxDay = Math.max(1, ...S.dayCompare.map((d) => Math.max(d.revenue, d.prevRevenue)));
  const dayRows = S.dayCompare.map((d, i) => {
    const w = Math.round((d.revenue / maxDay) * 100); const pw = Math.round((d.prevRevenue / maxDay) * 100);
    const best = S.bestDay && d.date === S.bestDay.date && d.revenue > 0;
    return `<tr>
      <td style="padding:10px 0 10px 14px;border-top:1px solid #eef2f6;font-size:13px;color:#0f172a;white-space:nowrap"><strong>${d.weekday}</strong><span style="color:#94a3b8;font-size:11px"> ${long(d.date)}</span>${best ? ' <span style="background:#fef3c7;color:#92400e;font-size:9px;font-weight:800;padding:2px 6px;border-radius:6px;letter-spacing:.5px">BEST</span>' : ''}</td>
      <td width="38%" style="padding:10px 8px;border-top:1px solid #eef2f6">
        <div style="height:8px;background:#e2e8f0;border-radius:6px;width:${Math.max(pw, d.prevRevenue ? 3 : 0)}%;margin-bottom:3px;font-size:0;line-height:0">&nbsp;</div>
        <div style="height:10px;background:${best ? '#f59e0b' : A};border-radius:6px;width:${Math.max(w, d.revenue ? 3 : 0)}%;font-size:0;line-height:0">&nbsp;</div></td>
      <td align="right" style="padding:10px 8px;border-top:1px solid #eef2f6;font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap">${esc(fmt(d.revenue))}<div style="font-size:10px;font-weight:400;color:#94a3b8">${nf(d.tx)} sale${d.tx === 1 ? '' : 's'}</div></td>
      <td align="right" style="padding:10px 14px 10px 4px;border-top:1px solid #eef2f6;white-space:nowrap">${d.revenue === 0 && d.prevRevenue === 0 ? '<span style="color:#cbd5e1">&ndash;</span>' : pill(d.change)}</td></tr>`;
  }).join('');

  const maxW = Math.max(1, ...S.weeks.map((w) => w.revenue));
  const weekRows = [...S.weeks].reverse().map((w, i) => {
    const label = i === 0 ? 'This week' : i === 1 ? 'Last week' : `${i} weeks ago`;
    return `<tr><td style="padding:9px 0 9px 14px;border-top:1px solid #eef2f6;font-size:13px;white-space:nowrap;color:#0f172a"><strong>${label}</strong><div style="font-size:10px;color:#94a3b8">${long(w.start)} &ndash; ${long(w.end)}</div></td>
      <td width="40%" style="padding:9px 8px;border-top:1px solid #eef2f6"><div style="height:12px;background:${i === 0 ? A : '#cbd5e1'};border-radius:6px;width:${Math.max(Math.round((w.revenue / maxW) * 100), w.revenue ? 3 : 0)}%;font-size:0;line-height:0">&nbsp;</div></td>
      <td align="right" style="padding:9px 14px 9px 8px;border-top:1px solid #eef2f6;font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap">${esc(fmt(w.revenue))}<div style="font-size:10px;font-weight:400;color:#94a3b8">${nf(w.tx)} sales</div></td></tr>`;
  }).join('');

  const stat = (label, value, change, sub) => `<td width="33%" valign="top" style="padding:0 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid #e8edf3;border-radius:14px"><tr><td style="padding:14px 14px 13px">
      <div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:700;color:#94a3b8">${label}</div>
      <div style="font-size:19px;font-weight:800;color:#0f172a;margin:5px 0 6px;letter-spacing:-.3px">${esc(value)}</div>
      <div>${pill(change)} <span style="font-size:10px;color:#94a3b8">${sub}</span></div></td></tr></table></td>`;

  const top = S.topProducts.slice(0, 5);
  const topHtml = top.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${top.map((p, i) => `<tr>
      <td width="28" style="padding:8px 0;border-top:${i ? '1px solid #eef2f6' : '0'};font-size:12px;font-weight:800;color:${i < 3 ? A : '#94a3b8'}">${i + 1}</td>
      <td style="padding:8px 6px;border-top:${i ? '1px solid #eef2f6' : '0'};font-size:13px;color:#0f172a">${esc(p.name)}<div style="font-size:10px;color:#94a3b8">${nf(p.units)} sold</div></td>
      <td align="right" style="padding:8px 0;border-top:${i ? '1px solid #eef2f6' : '0'};font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap">${esc(fmt(p.revenue))}</td></tr>`).join('')}</table>` : '<div style="font-size:13px;color:#94a3b8">No product sales this week.</div>';

  const branches = S.branches.length > 1 ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${S.branches.slice(0, 5).map((b, i) => `<tr>
      <td style="padding:8px 0;border-top:${i ? '1px solid #eef2f6' : '0'};font-size:13px;color:#0f172a">${esc(b.name)}<div style="font-size:10px;color:#94a3b8">${nf(b.tx)} sales</div></td>
      <td align="right" style="padding:8px 0;border-top:${i ? '1px solid #eef2f6' : '0'};font-size:13px;font-weight:700;color:#0f172a;white-space:nowrap">${esc(fmt(b.revenue))}</td></tr>`).join('')}</table>` : '';

  const alertCard = (tone, title, big, lines, hint) => {
    const t = { danger: ['#fef2f2', '#fecaca', BAD], warn: ['#fffbeb', '#fde68a', WARN], ok: ['#f0fdf4', '#bbf7d0', GOOD] }[tone];
    return `<td width="50%" valign="top" style="padding:0 5px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${t[0]};border:1px solid ${t[1]};border-radius:14px"><tr><td style="padding:16px 16px 14px">
      <div style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;font-weight:800;color:${t[2]}">${title}</div>
      <div style="font-size:24px;font-weight:800;color:#0f172a;margin:6px 0 6px;letter-spacing:-.4px">${esc(big)}</div>
      ${lines.map((l) => `<div style="font-size:12px;line-height:1.7;color:#475569">${l}</div>`).join('')}
      <div style="font-size:11px;margin-top:8px;color:${t[2]};font-weight:700">&#128206; ${hint}</div></td></tr></table></td>`;
  };
  const lowCard = alertCard(L.outCount ? 'danger' : L.lowCount ? 'warn' : 'ok', 'Low stock', L.total ? `${nf(L.total)} items` : 'All stocked',
    L.total ? [`<strong>${nf(L.outCount)}</strong> out of stock`, `<strong>${nf(L.lowCount)}</strong> running low`, `Est. restock: <strong>${esc(fmt(L.reorderCost))}</strong>`] : ['Nothing is below its minimum level.'], 'Low Stock PDF attached');
  const expTone = E.totals.expired.batches ? 'danger' : E.totals.thisWeek.batches ? 'warn' : 'ok';
  const expCard = alertCard(expTone, 'Expiry watch', E.totals.atRisk.batches ? fmt(E.totals.atRisk.costValue) : 'No risk',
    E.totals.atRisk.batches ? [`<strong>${E.totals.expired.batches}</strong> expired &middot; ${esc(fmt(E.totals.expired.costValue))} lost`, `<strong>${E.totals.thisWeek.batches}</strong> expiring in 7 days &middot; ${esc(fmt(E.totals.thisWeek.costValue))}`, `Next 30 days: <strong>${E.totals.later.batches}</strong> batches`] : ['No expired batches and none expiring this week.'], 'Expiry Report PDF attached');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="x-apple-disable-message-reformatting">
<title>Weekly report - ${esc(business.name)}</title>
<style>@media only screen and (max-width:640px){.wrap{padding:10px 6px!important}.px{padding-left:18px!important;padding-right:18px!important}.stack{display:block!important;width:100%!important;padding:0 0 10px!important}.hero{font-size:32px!important}}</style></head>
<body style="margin:0;padding:0;background:#eaeff4;font-family:${FONT};color:#0f172a;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${esc(`${business.name}: ${fmt(cur.revenue)} in sales (${changeText(S.change.revenue)} vs last week). ${L.total} low-stock items, ${E.totals.atRisk.batches} expiry batches at risk.`)}${'&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eaeff4"><tr><td align="center" class="wrap" style="padding:28px 14px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">

${demo ? `<tr><td style="background:#1e293b;color:#fde68a;text-align:center;font-size:12px;font-weight:700;letter-spacing:.6px;padding:9px 12px;border-radius:14px 14px 0 0">DEMO PREVIEW &middot; sent by the platform admin &middot; not sent to shop owners</td></tr>` : ''}
<tr><td style="background:${DK};background-image:linear-gradient(135deg,${DK} 0%,${A} 55%,${B} 100%);${demo ? '' : 'border-radius:22px 22px 0 0;'}padding:30px 36px 74px" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="font-size:13px;font-weight:800;letter-spacing:2px;color:#ccfbf1;text-transform:uppercase">${esc(brand())}</td>
    <td align="right" style="font-size:11px;font-weight:700;letter-spacing:1.4px;color:#99f6e4;text-transform:uppercase">Weekly report</td></tr></table>
  <div style="font-size:26px;line-height:1.2;font-weight:800;color:#ffffff;margin-top:22px;letter-spacing:-.4px">${esc(business.name)}</div>
  <div style="font-size:14px;color:#a7f3d0;margin-top:6px">${esc(longY(S.period.start))} &ndash; ${esc(longY(S.period.end))}</div>
</td></tr>

<tr><td style="background:#ffffff;padding:0 36px 8px" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:-52px;background:#ffffff;border-radius:18px;border:1px solid #e2e8f0;box-shadow:0 14px 34px -14px rgba(15,23,42,.35)"><tr><td align="center" style="padding:24px 18px 22px">
    <div style="font-size:11px;letter-spacing:1.6px;text-transform:uppercase;font-weight:800;color:#64748b">Total sales this week</div>
    <div class="hero" style="font-size:40px;line-height:1.1;font-weight:800;color:#0f172a;margin:8px 0 10px;letter-spacing:-1px">${esc(fmt(cur.revenue))}</div>
    <div>${pill(S.change.revenue, { big: true })} <span style="font-size:12px;color:#64748b">vs last week (${esc(fmt(S.lastWeek.revenue))})</span></div>
    <div style="font-size:12px;color:#94a3b8;margin-top:8px">${esc(headline)}${S.change.vsAvg3 !== null && S.avg3.revenue ? ` &middot; ${changeText(S.change.vsAvg3)} vs your 3-week average` : ''}</div>
  </td></tr></table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px -4px 6px;width:calc(100% + 8px)"><tr>
    ${stat('Transactions', nf(cur.tx), S.change.tx, 'vs last wk')}
    ${stat('Gross profit', fmt(cur.profit), S.change.profit, `${S.margin}% margin`)}
    ${stat('Avg. basket', fmt(cur.avgBasket), S.change.avgBasket, 'vs last wk')}
  </tr></table>
</td></tr>

<tr><td style="background:#ffffff;padding:18px 36px 6px" class="px">
  <div style="font-size:17px;font-weight:800;color:#0f172a">Day by day</div>
  <div style="font-size:12px;color:#64748b;margin:2px 0 10px">Sales per day. <span style="color:${A};font-weight:700">Green</span> = this week, <span style="color:#94a3b8;font-weight:700">grey</span> = same day last week.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8edf3;border-radius:14px;overflow:hidden;background:#ffffff">
    <tr style="background:#f8fafc"><td style="padding:9px 0 9px 14px;font-size:10px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:#94a3b8">Day</td><td></td><td align="right" style="padding:9px 8px;font-size:10px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:#94a3b8">Sales</td><td align="right" style="padding:9px 14px 9px 4px;font-size:10px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:#94a3b8">vs last wk</td></tr>
    ${dayRows}
    <tr style="background:#ecfdf5"><td colspan="2" style="padding:12px 0 12px 14px;border-top:2px solid ${A};font-size:13px;font-weight:800;color:${DK}">Whole week</td><td align="right" style="padding:12px 8px;border-top:2px solid ${A};font-size:14px;font-weight:800;color:${DK};white-space:nowrap">${esc(fmt(cur.revenue))}</td><td align="right" style="padding:12px 14px 12px 4px;border-top:2px solid ${A}">${pill(S.change.revenue)}</td></tr>
  </table>
</td></tr>

<tr><td style="background:#ffffff;padding:20px 36px 6px" class="px">
  <div style="font-size:17px;font-weight:800;color:#0f172a">Week vs previous weeks</div>
  <div style="font-size:12px;color:#64748b;margin:2px 0 10px">${S.avg3.revenue ? `Your 3-week average is ${esc(fmt(S.avg3.revenue))}.` : 'Not enough history yet to compare.'}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8edf3;border-radius:14px;overflow:hidden">${weekRows}</table>
</td></tr>

<tr><td style="background:#ffffff;padding:20px 36px 6px" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td class="stack" width="${branches ? '50%' : '100%'}" valign="top" style="padding-right:${branches ? '10px' : '0'}"><div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:8px">Top sellers</div>${topHtml}</td>
    ${branches ? `<td class="stack" width="50%" valign="top" style="padding-left:10px"><div style="font-size:15px;font-weight:800;color:#0f172a;margin-bottom:8px">By branch</div>${branches}</td>` : ''}
  </tr></table>
  ${S.bestDay && S.bestDay.revenue ? `<div style="margin-top:14px;background:#f8fafc;border-radius:12px;padding:12px 14px;font-size:12.5px;line-height:1.6;color:#475569">&#128161; <strong>${S.bestDay.weekday} ${long(S.bestDay.date)}</strong> was your best day (${esc(fmt(S.bestDay.revenue))}). The quietest was <strong>${S.quietDay.weekday}</strong> (${esc(fmt(S.quietDay.revenue))}) - a good day for a promotion.</div>` : ''}
</td></tr>

<tr><td style="background:#ffffff;padding:22px 31px 4px" class="px">
  <div style="font-size:17px;font-weight:800;color:#0f172a;padding:0 5px">Needs your attention</div>
  <div style="font-size:12px;color:#64748b;margin:2px 5px 12px">The full detail is in the two PDF reports attached to this email.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${lowCard}${expCard}</tr></table>
</td></tr>

<tr><td align="center" style="background:#ffffff;padding:20px 36px 30px;border-radius:0 0 22px 22px" class="px">
  ${url ? `${cta('Open dashboard', `${url}/dashboard.html`, true)}${cta('Batches & expiry', `${url}/batches.html`, false)}` : ''}
</td></tr>

<tr><td align="center" style="padding:20px 18px 6px;font-size:12px;line-height:1.7;color:#64748b">
  Sent every week to the owner and managers of <strong>${esc(business.name)}</strong>.<br>
  Sales exclude cancelled sales. Profit = sales (before tax) minus the cost price recorded at sale time.<br>
  Questions? <a href="mailto:${esc(supportEmail())}" style="color:${A};text-decoration:none">${esc(supportEmail())}</a> &middot; ${esc(supportPhone())}
</td></tr>
<tr><td align="center" style="padding:6px 18px 0;font-size:11px;color:#94a3b8">&copy; ${new Date().getFullYear()} ${esc(brand())}. All rights reserved.</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${business.name} - weekly report (${longY(S.period.start)} - ${longY(S.period.end)})`, '',
    `Total sales: ${fmt(cur.revenue)} (${changeText(S.change.revenue)} vs last week ${fmt(S.lastWeek.revenue)})`,
    `Transactions: ${cur.tx} | Gross profit: ${fmt(cur.profit)} | Avg basket: ${fmt(cur.avgBasket)}`, '',
    'Day by day:', ...S.dayCompare.map((d) => `  ${d.weekday} ${long(d.date)}: ${fmt(d.revenue)} (${d.tx} sales) ${changeText(d.change)}`), '',
    'Last 4 weeks:', ...[...S.weeks].reverse().map((w, i) => `  ${['This week', 'Last week', '2 weeks ago', '3 weeks ago'][i]}: ${fmt(w.revenue)}`), '',
    `Low stock: ${L.outCount} out of stock, ${L.lowCount} running low (est. restock ${fmt(L.reorderCost)}).`,
    `Expiry: ${E.totals.expired.batches} expired (${fmt(E.totals.expired.costValue)} lost), ${E.totals.thisWeek.batches} expiring within 7 days (${fmt(E.totals.thisWeek.costValue)}).`, '',
    'Two PDF reports are attached: Low Stock and Expiry.',
  ].join('\n');

  const subject = `${demo ? '[DEMO] ' : ''}${business.name}: weekly report - ${fmt(cur.revenue)} in sales${S.change.revenue === null ? '' : ` (${changeText(S.change.revenue)})`}`;
  return { html, text, subject };
}

module.exports = { build };
