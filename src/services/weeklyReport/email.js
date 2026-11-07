'use strict';
/**
 * weeklyReport/email.js - the weekly performance email (HTML + plain text).
 * Table layout + inline styles (Gmail / Outlook / Apple Mail). Icons are PNGs served from the frontend at
 * <EMAIL_ASSET_BASE_URL || APP_BASE_URL>/icons/email/<name>-<colour>.png - if no public base URL is set the icons are simply left out.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const NAVY = '#0b1f33'; const INK = '#14213d'; const TEAL = '#0f766e'; const MUTE = '#64748b'; const FAINT = '#94a3b8'; const LINE = '#e5e9ef'; const SOFT = '#f6f8fa';
const GOOD = '#15803d'; const BAD = '#dc2626'; const WARN = '#b45309';
const APP = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const ASSETS = () => String(process.env.EMAIL_ASSET_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const brand = () => process.env.BREVO_SENDER_NAME || 'Six Star POS';
const supportEmail = () => process.env.SUPPORT_EMAIL || 'info@sixstartechnologies.com';
const supportPhone = () => process.env.SUPPORT_PHONE || '0 111 976 842';

const long = (ds) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${ds}T12:00:00Z`));
const longY = (ds) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ds}T12:00:00Z`));
const nf = (n) => Number(n || 0).toLocaleString('en-KE', { maximumFractionDigits: 2 });
const changeText = (c) => (c === null ? 'new' : `${c > 0 ? '+' : ''}${c}%`);

/** Icon image (PNG, rendered at 2x). Returns '' when no public asset URL is configured. */
function ico(name, color = 'slate', size = 16, style = '') {
  const base = ASSETS(); if (!base) return '';
  return `<img src="${esc(`${base}/icons/email/${name}-${color}.png`)}" width="${size}" height="${size}" alt="" style="display:inline-block;vertical-align:middle;border:0;width:${size}px;height:${size}px;${style}">`;
}
/** Rounded tinted tile that holds an icon. */
const tile = (name, color, bg, size = 36) => `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="${size}" height="${size}" align="center" valign="middle" bgcolor="${bg}" style="width:${size}px;height:${size}px;background:${bg};border-radius:10px;line-height:0">${ico(name, color, Math.round(size * 0.5))}</td></tr></table>`;

/** Change pill: up / down / new / flat */
function pill(change, { big = false } = {}) {
  const fs = big ? 13 : 11; const sz = big ? 14 : 12;
  const base = `display:inline-block;padding:${big ? '4px 10px' : '3px 8px'};border-radius:999px;font-size:${fs}px;font-weight:700;line-height:1.3;white-space:nowrap`;
  if (change === null) return `<span style="${base};background:#e8f0fe;color:#1d4ed8">New</span>`;
  if (change === 0) return `<span style="${base};background:#eef1f5;color:${MUTE}">${ico('minus', 'slate', sz)} 0%</span>`;
  const up = change > 0; const v = Math.abs(change).toFixed(Math.abs(change) >= 100 ? 0 : 1);
  return `<span style="${base};background:${up ? '#e7f6ec' : '#fdeaea'};color:${up ? GOOD : BAD}">${ico(up ? 'trending-up' : 'trending-down', up ? 'green' : 'red', sz)} ${up ? '+' : '-'}${v}%</span>`;
}

const sectionTitle = (title, sub) => `<div style="font-size:16px;font-weight:700;color:${INK};letter-spacing:-.1px">${title}</div>${sub ? `<div style="font-size:12.5px;color:${MUTE};margin:3px 0 0;line-height:1.5">${sub}</div>` : ''}<div style="height:1px;background:${LINE};margin:12px 0 0;font-size:0;line-height:0">&nbsp;</div>`;
const th = (t, align = 'left', extra = '') => `<td align="${align}" style="padding:10px 12px;font-size:10.5px;letter-spacing:.9px;text-transform:uppercase;font-weight:700;color:${FAINT};${extra}">${t}</td>`;

function build(data, { demo = false } = {}) {
  const { sales: S, lowStock: L, expiry: E, fmt, business } = data;
  const cur = S.thisWeek; const url = APP();
  const btn = (label, href, primary) => (href ? `<a href="${esc(href)}" target="_blank" style="display:inline-block;margin:4px 6px;padding:13px 28px;border-radius:8px;font-family:${FONT};font-size:14px;font-weight:600;text-decoration:none;${primary ? `background:${NAVY};color:#ffffff;border:1px solid ${NAVY}` : `background:#ffffff;color:${NAVY};border:1px solid #cbd5e1`}">${esc(label)}</a>` : '');

  const headline = S.change.revenue === null ? 'No sales last week to compare with' : S.change.revenue >= 0 ? 'Sales grew compared with last week' : 'Sales were lower than last week';

  /* ---- day by day ---- */
  const maxDay = Math.max(1, ...S.dayCompare.map((d) => Math.max(d.revenue, d.prevRevenue)));
  const bar = (v, color, h) => `<table role="presentation" cellpadding="0" cellspacing="0" width="${Math.max(Math.round((v / maxDay) * 100), v ? 3 : 0)}%" style="width:${Math.max(Math.round((v / maxDay) * 100), v ? 3 : 0)}%"><tr><td height="${h}" bgcolor="${color}" style="height:${h}px;background:${color};border-radius:4px;font-size:0;line-height:0">&nbsp;</td></tr></table>`;
  const dayRows = S.dayCompare.map((d) => {
    const best = S.bestDay && d.date === S.bestDay.date && d.revenue > 0;
    return `<tr>
      <td style="padding:11px 12px;border-top:1px solid ${LINE};font-size:13px;color:${INK};white-space:nowrap"><strong>${d.weekday}</strong> <span style="color:${FAINT};font-size:12px">${long(d.date)}</span>${best ? `<div style="margin-top:2px">${ico('award', 'amber', 12)} <span style="font-size:10px;font-weight:700;color:${WARN};letter-spacing:.6px;vertical-align:middle">BEST DAY</span></div>` : ''}</td>
      <td width="34%" style="padding:11px 8px;border-top:1px solid ${LINE}">${bar(d.prevRevenue, '#d5dce5', 5)}<div style="height:3px;font-size:0;line-height:0">&nbsp;</div>${bar(d.revenue, best ? '#d97706' : TEAL, 8)}</td>
      <td align="right" style="padding:11px 8px;border-top:1px solid ${LINE};font-size:13px;font-weight:700;color:${INK};white-space:nowrap">${esc(fmt(d.revenue))}<div style="font-size:11px;font-weight:400;color:${FAINT}">${nf(d.tx)} sale${d.tx === 1 ? '' : 's'}</div></td>
      <td align="right" style="padding:11px 12px 11px 4px;border-top:1px solid ${LINE};white-space:nowrap">${d.revenue === 0 && d.prevRevenue === 0 ? `<span style="color:#cbd5e1">&ndash;</span>` : pill(d.change)}</td></tr>`;
  }).join('');

  /* ---- weeks ---- */
  const maxW = Math.max(1, ...S.weeks.map((w) => w.revenue));
  const weekRows = [...S.weeks].reverse().map((w, i) => {
    const label = ['This week', 'Last week', '2 weeks ago', '3 weeks ago'][i];
    const wd = Math.max(Math.round((w.revenue / maxW) * 100), w.revenue ? 3 : 0);
    return `<tr><td style="padding:12px;border-top:1px solid ${LINE};font-size:13px;white-space:nowrap;color:${INK}"><strong>${label}</strong><div style="font-size:11px;color:${FAINT}">${long(w.start)} &ndash; ${long(w.end)}</div></td>
      <td width="38%" style="padding:12px 8px;border-top:1px solid ${LINE}"><table role="presentation" cellpadding="0" cellspacing="0" width="${wd}%" style="width:${wd}%"><tr><td height="10" bgcolor="${i === 0 ? TEAL : '#c9d2dd'}" style="height:10px;background:${i === 0 ? TEAL : '#c9d2dd'};border-radius:5px;font-size:0;line-height:0">&nbsp;</td></tr></table></td>
      <td align="right" style="padding:12px;border-top:1px solid ${LINE};font-size:13px;font-weight:700;color:${INK};white-space:nowrap">${esc(fmt(w.revenue))}<div style="font-size:11px;font-weight:400;color:${FAINT}">${nf(w.tx)} sales</div></td></tr>`;
  }).join('');

  /* ---- KPI columns ---- */
  const kpi = (icon, label, value, change, sub, last) => `<td width="33.33%" valign="top" style="padding:18px 16px;${last ? '' : `border-right:1px solid ${LINE};`}">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="padding-right:8px">${tile(icon, 'teal', '#e6f4f1', 28)}</td><td valign="middle" style="font-size:11px;letter-spacing:.9px;text-transform:uppercase;font-weight:700;color:${MUTE}">${label}</td></tr></table>
      <div style="font-size:20px;font-weight:700;color:${INK};margin:10px 0 6px;letter-spacing:-.3px">${esc(value)}</div>
      <div>${pill(change)} <span style="font-size:11px;color:${FAINT}">${sub}</span></div></td>`;

  /* ---- top products / branches ---- */
  const list = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
  const top = S.topProducts.slice(0, 5);
  const topHtml = top.length ? list(top.map((p, i) => `<tr>
      <td width="26" valign="top" style="padding:9px 0;border-top:${i ? `1px solid ${LINE}` : '0'};font-size:12px;font-weight:700;color:${i < 3 ? TEAL : FAINT}">${i + 1}</td>
      <td style="padding:9px 6px 9px 0;border-top:${i ? `1px solid ${LINE}` : '0'};font-size:13px;color:${INK}">${esc(p.name)}<div style="font-size:11px;color:${FAINT}">${nf(p.units)} sold</div></td>
      <td align="right" valign="top" style="padding:9px 0;border-top:${i ? `1px solid ${LINE}` : '0'};font-size:13px;font-weight:700;color:${INK};white-space:nowrap">${esc(fmt(p.revenue))}</td></tr>`)) : `<div style="font-size:13px;color:${FAINT}">No product sales this week.</div>`;
  const branchHtml = S.branches.length > 1 ? list(S.branches.slice(0, 5).map((b, i) => `<tr>
      <td style="padding:9px 0;border-top:${i ? `1px solid ${LINE}` : '0'};font-size:13px;color:${INK}">${esc(b.name)}<div style="font-size:11px;color:${FAINT}">${nf(b.tx)} sales</div></td>
      <td align="right" valign="top" style="padding:9px 0;border-top:${i ? `1px solid ${LINE}` : '0'};font-size:13px;font-weight:700;color:${INK};white-space:nowrap">${esc(fmt(b.revenue))}</td></tr>`)) : '';

  /* ---- attention cards ---- */
  const card = ({ icon, tone, title, big, lines, file }) => {
    const t = { danger: [BAD, '#fdeaea', 'red'], warn: [WARN, '#fdf3e0', 'amber'], ok: [GOOD, '#e7f6ec', 'green'] }[tone];
    return `<td class="stack" width="50%" valign="top" style="padding:0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${LINE};border-top:3px solid ${t[0]};border-radius:8px"><tr><td style="padding:18px 18px 14px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle" style="padding-right:10px">${tile(icon, t[2], t[1], 34)}</td><td valign="middle"><div style="font-size:11px;letter-spacing:.9px;text-transform:uppercase;font-weight:700;color:${MUTE}">${title}</div></td></tr></table>
      <div style="font-size:24px;font-weight:700;color:${INK};margin:12px 0 8px;letter-spacing:-.4px">${esc(big)}</div>
      ${lines.map((l) => `<div style="font-size:12.5px;line-height:1.8;color:#475569">${l}</div>`).join('')}
      <div style="height:1px;background:${LINE};margin:12px 0 10px;font-size:0;line-height:0">&nbsp;</div>
      <div style="font-size:12px;color:${MUTE}">${ico('file-text', 'slate', 14)} <span style="vertical-align:middle">${file}</span></div></td></tr></table></td>`;
  };
  const lowCard = card({ icon: L.outCount ? 'alert' : 'boxes', tone: L.outCount ? 'danger' : L.lowCount ? 'warn' : 'ok', title: 'Low stock', big: L.total ? `${nf(L.total)} items` : 'All stocked',
    lines: L.total ? [`<strong style="color:${INK}">${nf(L.outCount)}</strong> out of stock`, `<strong style="color:${INK}">${nf(L.lowCount)}</strong> running low`, `Estimated restock cost <strong style="color:${INK}">${esc(fmt(L.reorderCost))}</strong>`] : ['Nothing is below its minimum level.'], file: 'Low Stock Report attached (PDF)' });
  const expTone = E.totals.expired.batches ? 'danger' : E.totals.thisWeek.batches ? 'warn' : 'ok';
  const expCard = card({ icon: 'clock', tone: expTone, title: 'Expiry watch', big: E.totals.atRisk.batches ? fmt(E.totals.atRisk.costValue) : 'No risk',
    lines: E.totals.atRisk.batches ? [`<strong style="color:${INK}">${E.totals.expired.batches}</strong> expired &middot; ${esc(fmt(E.totals.expired.costValue))} lost`, `<strong style="color:${INK}">${E.totals.thisWeek.batches}</strong> expiring within 7 days &middot; ${esc(fmt(E.totals.thisWeek.costValue))}`, `<strong style="color:${INK}">${E.totals.later.batches}</strong> more in the next 30 days`] : ['No expired batches, and none expiring this week.'], file: 'Expiry Report attached (PDF)' });

  const logo = ASSETS() ? `<img src="${esc(`${ASSETS()}/icons/icon-192.png`)}" width="34" height="34" alt="${esc(brand())}" style="display:block;border:0;border-radius:8px;width:34px;height:34px">` : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><meta name="x-apple-disable-message-reformatting">
<title>Weekly report - ${esc(business.name)}</title>
<style>@media only screen and (max-width:660px){.wrap{padding:0!important}.px{padding-left:20px!important;padding-right:20px!important}.stack{display:block!important;width:100%!important;padding:0 0 12px!important;box-sizing:border-box}.hero{font-size:32px!important}.kpi td{display:block!important;width:100%!important;border-right:0!important;border-top:1px solid #e5e9ef}}</style></head>
<body style="margin:0;padding:0;background:#f1f4f8;font-family:${FONT};color:${INK};-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${esc(`${business.name}: ${fmt(cur.revenue)} in sales (${changeText(S.change.revenue)} vs last week). ${L.total} low-stock items and ${E.totals.atRisk.batches} expiry batches need attention.`)}${'&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f4f8"><tr><td align="center" class="wrap" style="padding:28px 14px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:10px;overflow:hidden">

${demo ? `<tr><td align="center" style="background:#fff7e0;border-bottom:1px solid #f3dfa2;color:#8a5a00;font-size:12px;font-weight:600;padding:9px 12px">Demo preview &middot; sent by the platform admin only &middot; shop owners did not receive this</td></tr>` : ''}

<tr><td style="background:${NAVY};padding:20px 32px" class="px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  ${logo ? `<td width="44" valign="middle">${logo}</td>` : ''}
  <td valign="middle" style="font-size:16px;font-weight:700;color:#ffffff;letter-spacing:.2px">${esc(brand())}</td>
  <td align="right" valign="middle" style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;font-weight:600;color:#9fb3c8">Weekly Business Report</td></tr></table></td></tr>

<tr><td style="padding:30px 32px 6px" class="px">
  <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;color:${TEAL}">Weekly performance summary</div>
  <div style="font-size:26px;line-height:1.25;font-weight:700;color:${INK};margin:8px 0 8px;letter-spacing:-.5px">${esc(business.name)}</div>
  <div style="font-size:13px;color:${MUTE}">${ico('calendar', 'slate', 14)} <span style="vertical-align:middle">${esc(longY(S.period.start))} &ndash; ${esc(longY(S.period.end))}</span></div>
</td></tr>

<tr><td style="padding:20px 32px 0" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT};border:1px solid ${LINE};border-radius:10px"><tr><td style="padding:22px 22px 20px">
    <div style="font-size:11px;letter-spacing:1.3px;text-transform:uppercase;font-weight:700;color:${MUTE}">Total sales</div>
    <div class="hero" style="font-size:38px;line-height:1.15;font-weight:700;color:${INK};margin:6px 0 10px;letter-spacing:-1px">${esc(fmt(cur.revenue))}</div>
    <div>${pill(S.change.revenue, { big: true })} <span style="font-size:12.5px;color:${MUTE};margin-left:4px">vs last week (${esc(fmt(S.lastWeek.revenue))})</span></div>
    <div style="font-size:12.5px;color:${MUTE};margin-top:10px;line-height:1.5">${esc(headline)}${S.change.vsAvg3 !== null && S.avg3.revenue ? ` &middot; ${changeText(S.change.vsAvg3)} against your 3-week average of ${esc(fmt(S.avg3.revenue))}` : ''}.</div>
  </td></tr></table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="kpi" style="margin-top:12px;border:1px solid ${LINE};border-radius:10px"><tr>
    ${kpi('receipt', 'Transactions', nf(cur.tx), S.change.tx, 'vs last week', false)}
    ${kpi('wallet', 'Gross profit', fmt(cur.profit), S.change.profit, `${S.margin}% margin`, false)}
    ${kpi('basket', 'Avg. basket', fmt(cur.avgBasket), S.change.avgBasket, 'vs last week', true)}
  </tr></table>
</td></tr>

<tr><td style="padding:32px 32px 0" class="px">
  ${sectionTitle('Sales by day', `This week compared with the same day last week. <span style="color:${TEAL};font-weight:700">Teal</span> is this week, <span style="color:${FAINT};font-weight:700">grey</span> is last week.`)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">
    <tr style="background:${SOFT}">${th('Day')}${th('')}${th('Sales', 'right')}${th('Change', 'right')}</tr>
    ${dayRows}
    <tr style="background:#eef6f4"><td colspan="2" style="padding:13px 12px;border-top:2px solid ${TEAL};font-size:13px;font-weight:700;color:${INK}">Whole week</td><td align="right" style="padding:13px 8px;border-top:2px solid ${TEAL};font-size:14px;font-weight:700;color:${INK};white-space:nowrap">${esc(fmt(cur.revenue))}</td><td align="right" style="padding:13px 12px 13px 4px;border-top:2px solid ${TEAL}">${pill(S.change.revenue)}</td></tr>
  </table>
</td></tr>

<tr><td style="padding:32px 32px 0" class="px">
  ${sectionTitle('This week against previous weeks', S.avg3.revenue ? `Your 3-week average is ${esc(fmt(S.avg3.revenue))}.` : 'Not enough history yet to compare.')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${weekRows}</table>
</td></tr>

<tr><td style="padding:32px 32px 0" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td class="stack" width="${branchHtml ? '50%' : '100%'}" valign="top" style="padding-right:${branchHtml ? '14px' : '0'}">${sectionTitle('Top sellers', 'By sales value')}<div style="margin-top:4px">${topHtml}</div></td>
    ${branchHtml ? `<td class="stack" width="50%" valign="top" style="padding-left:14px">${sectionTitle('Sales by branch', 'This week')}<div style="margin-top:4px">${branchHtml}</div></td>` : ''}
  </tr></table>
  ${S.bestDay && S.bestDay.revenue ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;background:${SOFT};border-left:3px solid ${TEAL};border-radius:0 8px 8px 0"><tr><td width="44" valign="top" style="padding:14px 0 14px 14px">${ico('lightbulb', 'teal', 20)}</td><td style="padding:14px 16px 14px 6px;font-size:13px;line-height:1.6;color:#475569"><strong style="color:${INK}">Insight.</strong> ${S.bestDay.weekday} ${long(S.bestDay.date)} was your best day at ${esc(fmt(S.bestDay.revenue))}. ${S.quietDay.weekday} was the quietest at ${esc(fmt(S.quietDay.revenue))}, which makes it a good day for a promotion.</td></tr></table>` : ''}
</td></tr>

<tr><td style="padding:34px 26px 0" class="px">
  <div style="padding:0 6px">${sectionTitle('Inventory needs attention', 'The complete lists are in the two PDF reports attached to this email.')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr>${lowCard}${expCard}</tr></table>
</td></tr>

<tr><td align="center" style="padding:26px 32px 32px" class="px">${url ? `${btn('Open dashboard', `${url}/dashboard.html`, true)}${btn('Batches & expiry', `${url}/batches.html`, false)}` : ''}</td></tr>

<tr><td style="background:${SOFT};border-top:1px solid ${LINE};padding:22px 32px" class="px" align="center">
  <div style="font-size:12px;line-height:1.7;color:${MUTE}">This report is sent every week to the owner and managers of <strong style="color:${INK}">${esc(business.name)}</strong>.<br>Sales exclude cancelled sales. Gross profit is sales before tax minus the cost price recorded at the time of sale.</div>
  <div style="font-size:12px;color:${MUTE};margin-top:10px">Need help? <a href="mailto:${esc(supportEmail())}" style="color:${TEAL};text-decoration:none;font-weight:600">${esc(supportEmail())}</a> &nbsp;|&nbsp; ${esc(supportPhone())}</div>
  <div style="font-size:11px;color:${FAINT};margin-top:10px">&copy; ${new Date().getFullYear()} ${esc(brand())}. All rights reserved.</div>
</td></tr>
</table></td></tr></table></body></html>`;

  const text = [
    `${business.name} - weekly report (${longY(S.period.start)} - ${longY(S.period.end)})`, '',
    `Total sales: ${fmt(cur.revenue)} (${changeText(S.change.revenue)} vs last week ${fmt(S.lastWeek.revenue)})`,
    `Transactions: ${cur.tx} | Gross profit: ${fmt(cur.profit)} | Avg basket: ${fmt(cur.avgBasket)}`, '',
    'Sales by day:', ...S.dayCompare.map((d) => `  ${d.weekday} ${long(d.date)}: ${fmt(d.revenue)} (${d.tx} sales) ${changeText(d.change)}`), '',
    'Last 4 weeks:', ...[...S.weeks].reverse().map((w, i) => `  ${['This week', 'Last week', '2 weeks ago', '3 weeks ago'][i]}: ${fmt(w.revenue)}`), '',
    `Low stock: ${L.outCount} out of stock, ${L.lowCount} running low (est. restock ${fmt(L.reorderCost)}).`,
    `Expiry: ${E.totals.expired.batches} expired (${fmt(E.totals.expired.costValue)} lost), ${E.totals.thisWeek.batches} expiring within 7 days (${fmt(E.totals.thisWeek.costValue)}).`, '',
    'Two PDF reports are attached: Low Stock and Expiry.',
  ].join('\n');

  const subject = `${demo ? '[DEMO] ' : ''}${business.name}: weekly report - ${fmt(cur.revenue)} in sales${S.change.revenue === null ? '' : ` (${changeText(S.change.revenue)})`}`;
  return { html, text, subject };
}

module.exports = { build };
