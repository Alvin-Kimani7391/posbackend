/** Small RFC-4180 CSV reader/writer (quotes, escaped quotes, CRLF, BOM, ; or , or tab delimiter). No dependency. */
function detectDelimiter(headerLine) {
  const c = { ',': 0, ';': 0, '\t': 0 }; let q = false;
  for (const ch of headerLine) { if (ch === '"') q = !q; else if (!q && ch in c) c[ch] += 1; }
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const delim = detectDelimiter(src.split(/\r?\n/, 1)[0] || '');
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i += 1; row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}
// Cells that a spreadsheet would run as a formula are prefixed so an exported file is safe to open.
const safe = (v) => { const s = v == null ? '' : String(v); return /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s; };
const cell = (v) => { const s = safe(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows) => `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
module.exports = { parseCsv, toCsv };
