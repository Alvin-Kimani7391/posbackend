const CODE_RE = /^[A-Z][A-Z0-9]{9}$/;
const looksLikeReceipt = (c) => typeof c === 'string' && CODE_RE.test(c.trim().toUpperCase());

/** Best-effort read of an M-PESA confirmation SMS. Never trusted on its own - the admin verifies against the real statement. */
function parseMpesaMessage(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const c = text.match(/\b([A-Za-z][A-Za-z0-9]{9})\s+confirmed\b/i);
  const code = c ? c[1].toUpperCase() : null;
  const a = text.match(/(?:Ksh|KES)\.?\s?([\d,]+(?:\.\d{1,2})?)/i);
  const amt = a ? Math.round(parseFloat(a[1].replace(/,/g, '')) * 100) : null;
  const r = text.match(/(?:paid to|sent to)\s+(.+?)(?:\s+on\s+\d{1,2}\/\d{1,2}\/\d{2,4}|\.\s|$)/i);
  return {
    text,
    code: code && CODE_RE.test(code) ? code : null,
    amountCents: Number.isFinite(amt) && amt > 0 ? amt : null,
    recipient: r ? r[1].trim().slice(0, 80) : null,
    looksReceived: /you have received/i.test(text),
  };
}

module.exports = { looksLikeReceipt, parseMpesaMessage };