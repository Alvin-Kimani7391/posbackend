const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const kes = (cents) => {
  const n = Number(cents || 0) / 100;
  return `KES ${n.toLocaleString('en-KE', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
};

const fmtDate = (d) => (d ? new Intl.DateTimeFormat('en-KE', { dateStyle: 'medium', timeZone: 'Africa/Nairobi' }).format(new Date(d)) : '-');

function renderEmail({ heading, greeting, paragraphs = [], rows = [], cta, footnote }) {
  const rowsHtml = rows.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e5e7eb;border-radius:8px;border-collapse:separate">${rows
        .map(([k, v]) => `<tr><td style="padding:10px 14px;color:#667085;font-size:14px;border-bottom:1px solid #f2f4f7">${esc(k)}</td><td style="padding:10px 14px;font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid #f2f4f7">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : '';
  const button = cta && cta.url
    ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:#0f766e;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:#0f766e;color:#fff;padding:18px 24px;font-size:18px;font-weight:700">Six Star POS</td></tr>
<tr><td style="padding:24px">
<h2 style="margin:0 0 12px;font-size:20px">${esc(heading)}</h2>
${greeting ? `<p style="margin:0 0 12px;font-size:15px">${esc(greeting)}</p>` : ''}
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55">${esc(p)}</p>`).join('')}
${rowsHtml}${button}
${footnote ? `<p style="margin:16px 0 0;font-size:12px;color:#667085">${esc(footnote)}</p>` : ''}
</td></tr></table></td></tr></table></body></html>`;
}

module.exports = { esc, kes, fmtDate, renderEmail };