'use strict';
/**
 * Best-effort reader for the confirmation SMS of a Tanzanian mobile-money / bank payment (M-Pesa Vodacom, Mixx by Yas,
 * Airtel Money, HaloPesa ...). Formats differ per network and change over time, so NOTHING here is trusted: the
 * owner may type the transaction code and amount themselves, and a platform admin verifies every payment against the
 * real statement before it is credited.
 */
const CODE_LABELLED = /(?:muamala|transaction|trans|txn|tid|reference|ref|kumbukumbu)[\s.]*(?:no|id|number|namba)?[\s.:#-]*([A-Z0-9]{6,20})\b/i;
const CODE_LEADING = /^\s*([A-Z0-9]{8,14})\s+(?:confirmed|imethibitishwa|umethibitisha)/i;
const AMOUNT_RE = /(?:TZS|TSh|Tsh|T\.?Sh\.?)\s?([\d,]+(?:\.\d{1,2})?)/i;
const AMOUNT_AFTER = /([\d,]+(?:\.\d{1,2})?)\s?(?:TZS|TSh|Tsh)\b/i;

const CODE_OK = /^[A-Z0-9]{6,20}$/;
const looksLikeCode = (c) => {
  if (typeof c !== 'string') return false;
  const v = c.trim().toUpperCase();
  // Letters+digits (6-20), or an all-numeric id of at least 8 digits (some networks use purely numeric ids).
  return CODE_OK.test(v) && ((/[A-Z]/.test(v) && /\d/.test(v)) || /^\d{8,20}$/.test(v));
};

function parseTzMessage(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  const c = text.match(CODE_LEADING) || text.match(CODE_LABELLED);
  const code = c ? c[1].toUpperCase() : null;
  const a = text.match(AMOUNT_RE) || text.match(AMOUNT_AFTER);
  const amt = a ? Math.round(parseFloat(a[1].replace(/,/g, '')) * 100) : null;
  const r = text.match(/(?:to|kwa|kwenda)\s+([A-Za-z0-9 .&'-]{3,60}?)(?:\s+(?:on|tarehe|at|saa)\b|\.|,|$)/i);
  return {
    text,
    code: code && looksLikeCode(code) ? code : null,
    amountCents: Number.isFinite(amt) && amt > 0 ? amt : null,
    recipient: r ? r[1].trim().slice(0, 80) : null,
    looksReceived: /(?:you have received|umepokea)/i.test(text),
  };
}

module.exports = { parseTzMessage, looksLikeCode };
