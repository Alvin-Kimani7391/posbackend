const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const { formatMoney } = require('./currency');

/** Amount in cents -> "KES 1,250.50" / "TZS 15,000" in the given currency (default KES for legacy documents). */
const money = (cents, currency = 'KES') => formatMoney(cents, currency || 'KES');
const kes = (cents) => money(cents, 'KES'); // kept for older callers

const fmtDate = (d) => (d ? new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeZone: 'Africa/Nairobi' }).format(new Date(d)) : '-');

const THEMES = {
  teal:   { a: '#0f766e', b: '#14b8a6', soft: '#ecfdf5', line: '#a7f3d0', ink: '#065f46' },
  indigo: { a: '#4338ca', b: '#7c3aed', soft: '#eef2ff', line: '#c7d2fe', ink: '#312e81' },
  rose:   { a: '#be123c', b: '#f43f5e', soft: '#fff1f2', line: '#fecdd3', ink: '#881337' },
  amber:  { a: '#b45309', b: '#f59e0b', soft: '#fffbeb', line: '#fde68a', ink: '#78350f' },
};
const FONT = "'Segoe UI',-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif";
const supportEmail = () => process.env.SUPPORT_EMAIL || 'info@sixstartechnologies.com';
const supportPhone = () => process.env.SUPPORT_PHONE || '0 111 976 842';

/**
 * Branded, mobile-friendly HTML email (table layout + inline styles so it renders in Gmail, Outlook and Apple Mail).
 * Every field is optional except heading:
 *  theme: 'teal' | 'indigo' | 'rose' | 'amber'   icon: an emoji shown in the hero badge   eyebrow: small label above the heading
 *  preheader: inbox preview text   lead: larger intro line under the heading   greeting / paragraphs[] / rows[[k,v]]
 *  highlight: {label, value} big code box   steps: [{title,text}]   cta / cta2: {label,url}   notice: {title,text,tone:'warn'|'info'}
 *  footnote / reason: small print
 */
function renderEmail({ heading, greeting, paragraphs = [], rows = [], cta, cta2, footnote, theme = 'teal', icon, eyebrow, preheader, lead, highlight, steps = [], notice, reason }) {
  const t = THEMES[theme] || THEMES.teal;
  const year = new Date().getFullYear();

  const para = (p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">${esc(p)}</p>`;

  const highlightHtml = highlight && highlight.value ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 22px"><tr><td align="center" style="background:${t.soft};border:2px dashed ${t.line};border-radius:14px;padding:18px 12px">
      <div style="font-size:11px;letter-spacing:1.6px;text-transform:uppercase;font-weight:700;color:${t.ink};opacity:.8">${esc(highlight.label)}</div>
      <div style="font-family:'SFMono-Regular',Consolas,'Courier New',monospace;font-size:28px;letter-spacing:5px;font-weight:800;color:${t.a};margin-top:6px">${esc(highlight.value)}</div>
    </td></tr></table>` : '';

  const rowsHtml = rows.length ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;background:#f8fafc;border-radius:12px;border-left:4px solid ${t.b}">
      ${rows.map(([k, v], i) => `<tr><td style="padding:12px 16px;font-size:13px;color:#64748b;${i ? 'border-top:1px solid #e8edf3;' : ''}">${esc(k)}</td><td align="right" style="padding:12px 16px;font-size:14px;font-weight:700;color:#0f172a;${i ? 'border-top:1px solid #e8edf3;' : ''}">${esc(v)}</td></tr>`).join('')}
    </table>` : '';

  const stepsHtml = steps.length ? `
    <div style="font-size:12px;letter-spacing:1.4px;text-transform:uppercase;font-weight:700;color:#94a3b8;margin:6px 0 12px">Get started</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px">
      ${steps.map((st, i) => { const o = typeof st === 'string' ? { title: st } : st; return `<tr>
        <td width="44" valign="top" style="padding:0 0 14px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" width="30" height="30" style="width:30px;height:30px;border-radius:15px;background:${t.a};background-image:linear-gradient(135deg,${t.a},${t.b});color:#fff;font-weight:700;font-size:14px;line-height:30px">${i + 1}</td></tr></table></td>
        <td valign="top" style="padding:3px 0 14px"><div style="font-size:15px;font-weight:700;color:#0f172a">${esc(o.title)}</div>${o.text ? `<div style="font-size:14px;line-height:1.6;color:#64748b;margin-top:2px">${esc(o.text)}</div>` : ''}</td></tr>`; }).join('')}
    </table>` : '';

  const button = (c, primary) => `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 12px"><tr><td align="center" bgcolor="${primary ? t.a : '#ffffff'}" style="border-radius:12px;${primary ? `background:${t.a};background-image:linear-gradient(135deg,${t.a},${t.b});box-shadow:0 8px 18px -6px ${t.a}99;` : `border:2px solid ${t.line};`}">
      <a href="${esc(c.url)}" target="_blank" style="display:block;padding:15px 38px;font-family:${FONT};font-size:16px;font-weight:700;color:${primary ? '#ffffff' : t.a};text-decoration:none;border-radius:12px">${esc(c.label)}</a>
    </td></tr></table>`;
  const ctaHtml = cta && cta.url ? `<div style="text-align:center;margin:10px 0 6px">${button(cta, true)}${cta2 && cta2.url ? button(cta2, false) : ''}</div>
    <div style="text-align:center;font-size:12px;line-height:1.6;color:#94a3b8;margin:6px 0 22px">Button not working? Copy this link into your browser:<br><a href="${esc(cta.url)}" style="color:${t.a};word-break:break-all;text-decoration:none">${esc(cta.url)}</a></div>` : '';

  const nt = notice && notice.text ? (notice.tone === 'info'
    ? { bg: '#eff6ff', bd: '#bfdbfe', fg: '#1e3a8a', ic: '\u2139\uFE0F' }
    : { bg: '#fffbeb', bd: '#fde68a', fg: '#78350f', ic: '\uD83D\uDEE1\uFE0F' }) : null;
  const noticeHtml = nt ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px"><tr><td style="background:${nt.bg};border:1px solid ${nt.bd};border-radius:12px;padding:14px 16px;font-size:13px;line-height:1.6;color:${nt.fg}">
      <strong>${nt.ic}&nbsp; ${esc(notice.title || 'Good to know')}</strong><br>${esc(notice.text)}</td></tr></table>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="x-apple-disable-message-reformatting">
<title>${esc(heading)}</title>
<style>@media only screen and (max-width:620px){.wrap{padding:12px 8px!important}.px{padding-left:22px!important;padding-right:22px!important}.h1{font-size:26px!important}}</style></head>
<body style="margin:0;padding:0;background:#eaeff4;font-family:${FONT};color:#0f172a;-webkit-font-smoothing:antialiased">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px">${esc(preheader || lead || heading)}${'&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eaeff4"><tr><td align="center" class="wrap" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

<tr><td style="background:${t.a};background-image:linear-gradient(135deg,${t.a} 0%,${t.b} 100%);border-radius:22px 22px 0 0;padding:30px 40px 44px" class="px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td align="center" width="38" height="38" style="width:38px;height:38px;border-radius:11px;background:rgba(255,255,255,.2);color:#fff;font-size:20px;line-height:38px">&#9733;</td>
      <td style="padding-left:11px;font-size:18px;font-weight:800;letter-spacing:.2px;color:#fff">Six Star POS</td></tr></table></td>
    <td align="right" valign="middle" style="font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:rgba(255,255,255,.75);font-weight:600">${esc(eyebrow || '')}</td>
  </tr></table>
  <div style="text-align:center;padding-top:30px">
    ${icon ? `<table role="presentation" align="center" cellpadding="0" cellspacing="0"><tr><td align="center" width="68" height="68" style="width:68px;height:68px;border-radius:34px;background:#ffffff;font-size:32px;line-height:68px;box-shadow:0 10px 24px -8px rgba(0,0,0,.35)">${icon}</td></tr></table>` : ''}
    <h1 class="h1" style="margin:${icon ? '20px' : '0'} 0 0;font-size:30px;line-height:1.2;font-weight:800;color:#ffffff;letter-spacing:-.3px">${esc(heading)}</h1>
    ${lead ? `<p style="margin:12px auto 0;max-width:420px;font-size:16px;line-height:1.55;color:rgba(255,255,255,.88)">${esc(lead)}</p>` : ''}
  </div>
</td></tr>

<tr><td class="px" style="background:#ffffff;padding:36px 40px 30px">
  ${greeting ? `<p style="margin:0 0 16px;font-size:17px;font-weight:700;color:#0f172a">${esc(greeting)}</p>` : ''}
  ${paragraphs.map(para).join('')}
  ${highlightHtml}${rowsHtml}${stepsHtml}${ctaHtml}${noticeHtml}
  ${footnote ? `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#94a3b8">${esc(footnote)}</p>` : ''}
</td></tr>

<tr><td class="px" style="background:#f8fafc;border-top:1px solid #e8edf3;border-radius:0 0 22px 22px;padding:26px 40px;text-align:center">
  <div style="font-size:13px;color:#475569;line-height:1.7">Need help? We\u2019re one message away.<br>
    <a href="mailto:${esc(supportEmail())}" style="color:${t.a};font-weight:700;text-decoration:none">${esc(supportEmail())}</a> &nbsp;&bull;&nbsp; <a href="tel:${esc(String(supportPhone()).replace(/\s+/g, ''))}" style="color:${t.a};font-weight:700;text-decoration:none">${esc(supportPhone())}</a></div>
  <div style="height:1px;background:#e8edf3;margin:18px 0"></div>
  <div style="font-size:12px;color:#94a3b8;line-height:1.7">${esc(reason || 'You received this email because of activity on your Six Star POS account.')}<br>&copy; ${year} Six Star Technologies &middot; Six Star POS. All rights reserved.</div>
</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = { esc, kes, money, fmtDate, renderEmail };