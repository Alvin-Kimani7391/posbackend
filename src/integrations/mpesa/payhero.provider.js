const axios = require('axios');
const ApiError = require('../../utils/ApiError');
const { interpretInitiateError } = require('../../utils/mpesaErrors');

/**
 * Thin wrapper over PayHero's HTTP API. Auth is HTTP Basic - either a
 * ready-made "Basic xxxx" token PayHero hands out directly, or one we build
 * ourselves from apiUsername/apiPassword. Credentials come out of
 * IntegrationSettings.mpesa (decrypted just-in-time by the caller, never
 * cached on this object across businesses since this is stateless).
 *
 * Docs: https://docs.payhero.co.ke (Initiate MPESA STK Push, Get Transaction Status)
 */
const BASE_URL = process.env.PAYHERO_BASE_URL || 'https://backend.payhero.co.ke/api/v2';

function authHeader(credentials) {
  const raw = (credentials.basicAuthToken || '').toString();
  if (raw.trim()) {
    // Strip any existing "Basic " prefix (case-insensitive) so we never
    // double-prefix, and strip all whitespace/newlines a paste can carry.
    const token = raw.replace(/^\s*basic\s+/i, '').replace(/\s+/g, '');
    return { Authorization: `Basic ${token}` };
  }
  const token = Buffer.from(`${credentials.apiUsername}:${credentials.apiPassword}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function stkPush({ credentials, channelId, amountCents, phone, externalReference, customerName, callbackUrl }) {
  const amount = Math.round(amountCents / 100); // PayHero's `amount` is whole KES, not cents
  try {
    const res = await axios.post(
      `${BASE_URL}/payments`,
      {
        amount,
        phone_number: normalizePhone(phone),
        channel_id: Number(channelId),
        provider: 'm-pesa',
        external_reference: externalReference,
        customer_name: customerName || undefined,
        callback_url: callbackUrl,
      },
      { headers: { 'Content-Type': 'application/json', ...authHeader(credentials) }, timeout: 15000 }
    );
    if (res.data.success !== true) {
      // Accepted the HTTP call but PayHero itself rejected the request body.
      const e = new Error(res.data.error_message || 'PayHero declined this request');
      e.response = { data: res.data };
      throw e;
    }
    return { status: res.data.status, reference: res.data.reference, checkoutRequestId: res.data.CheckoutRequestID, raw: res.data };
  } catch (err) {
    console.error('[PayHero STK] request failed', {
      status: err.response?.status,
      body: err.response?.data,
      // never log credentials or the Authorization header
    });
    const interpreted = interpretInitiateError(err);
    const apiErr = ApiError.externalService(interpreted.message, 'MPESA_STK_FAILED');
    apiErr.mpesaFailureType = interpreted.type;
    throw apiErr;
  }
}

/** Active poll against PayHero, used by the reconciliation job and the manual "check status" button - never the only source of truth, the callback is primary. NOTE: this endpoint never returns a receipt number, only status - see mpesa.service.toClientShape. */
async function getTransactionStatus({ credentials, reference }) {
  try {
    const res = await axios.get(`${BASE_URL}/transaction-status`, {
      params: { reference },
      headers: authHeader(credentials),
      timeout: 15000,
    });
    return res.data; // { success, status: QUEUED|SUCCESS|FAILED, reference, CheckoutRequestID }
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    throw ApiError.externalService(`PayHero status check failed: ${msg}`, 'MPESA_STATUS_CHECK_FAILED');
  }
}

/** PayHero requires 07xx/2547xx - normalize whatever the cashier typed. */
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  return digits;
}

/**
 * PayHero's callback shape isn't 100% guaranteed stable across accounts, so
 * this reads defensively: try known field names, top-level or nested under
 * `response`, and always fall back to a live GET /transaction-status if the
 * callback doesn't clearly resolve to SUCCESS/FAILED (see mpesa.service).
 */
function parseCallback(body) {
  const d = body?.response || body?.Body?.stkCallback || body || {};
  const resultCode = d.ResultCode ?? d.resultCode;
  const statusRaw = (d.Status || d.status || '').toString().toUpperCase();

  let status = 'PENDING';
  if (statusRaw === 'SUCCESS' || resultCode === 0 || resultCode === '0') status = 'SUCCESS';
  else if (statusRaw === 'FAILED' || (resultCode !== undefined && resultCode !== null && Number(resultCode) !== 0)) status = 'FAILED';
  else if (statusRaw === 'CANCELLED') status = 'CANCELLED';

  return {
    status,
    reference: d.ExternalReference || d.external_reference || d.reference,
    checkoutRequestId: d.CheckoutRequestID || d.checkoutRequestId,
    mpesaReceiptNumber: d.MpesaReceiptNumber || d.mpesaReceiptNumber,
    resultCode: resultCode !== undefined ? String(resultCode) : undefined,
    resultDesc: d.ResultDesc || d.resultDesc,
    amount: d.Amount || d.amount,
  };
}

/* ---------------------------------------------------------------------- *
 * Inbound (Buy Goods / Till) payment notification
 * ---------------------------------------------------------------------- */

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** Safaricom-style { CallbackMetadata: { Item: [{ Name, Value }] } } -> flat object. */
function flattenCallbackMetadata(d) {
  const items = d?.CallbackMetadata?.Item;
  if (!Array.isArray(items)) return {};
  return items.reduce((acc, it) => {
    if (it && it.Name) acc[it.Name] = it.Value;
    return acc;
  }, {});
}

/** Accepts yyyyMMddHHmmss (Safaricom, Nairobi time) or any ISO-ish string. Returns null when unusable. */
function parseMpesaTime(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (/^\d{14}$/.test(s)) {
    const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+03:00`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * parseInboundPayment - reads a "money arrived on the till" notification defensively
 * (same philosophy as parseCallback: PayHero's payload shape is not guaranteed identical
 * across accounts). It only EXTRACTS; every trust decision (token, receipt-code shape,
 * amount, till number, duplicate) is made by mpesa.service.ingestInboundPayment.
 * Returns null when the body is not an object at all.
 */
function parseInboundPayment(body) {
  if (!body || typeof body !== 'object') return null;
  const root = body.response || body.data || body?.Body?.stkCallback || body;
  const d = { ...root, ...flattenCallbackMetadata(root) };

  const receipt = pickFirst(d, [
    'MpesaReceiptNumber', 'mpesaReceiptNumber', 'mpesa_receipt_number',
    'TransID', 'trans_id', 'transaction_reference', 'TransactionReference', 'receipt_number',
  ]);

  const amountNum = Number(pickFirst(d, ['Amount', 'amount', 'TransAmount', 'trans_amount']));
  const amountCents = Number.isFinite(amountNum) && amountNum > 0 ? Math.round(amountNum * 100) : null;

  const externalReference = pickFirst(d, ['ExternalReference', 'external_reference']);
  const resultCode = pickFirst(d, ['ResultCode', 'resultCode']);
  const statusRaw = String(pickFirst(d, ['Status', 'status']) ?? '').toUpperCase();

  let success;
  if (resultCode !== undefined) success = Number(resultCode) === 0;
  else if (statusRaw) success = ['SUCCESS', 'SUCCESSFUL', 'COMPLETED'].includes(statusRaw);
  else success = true; // till notifications are only sent for completed payments; the receipt-code shape gate in the service still applies

  const transactionType = String(pickFirst(d, ['transaction_type', 'TransactionType', 'type']) ?? '');
  const isInbound = !/(withdraw|fee|charge|payout|refund|transfer_out|reversal)/i.test(transactionType);

  const firstName = pickFirst(d, ['FirstName', 'first_name']);
  const middleName = pickFirst(d, ['MiddleName', 'middle_name']);
  const lastName = pickFirst(d, ['LastName', 'last_name']);
  const payerName = pickFirst(d, ['customer_name', 'CustomerName', 'name'])
    || [firstName, middleName, lastName].filter(Boolean).join(' ')
    || undefined;

  return {
    receiptNumber: receipt !== undefined ? String(receipt).trim().toUpperCase() : undefined,
    amountCents,
    success,
    isInbound,
    isStk: typeof externalReference === 'string' && /^MPX-/i.test(externalReference),
    payerPhone: pickFirst(d, ['MSISDN', 'msisdn', 'phone_number', 'phone', 'PhoneNumber', 'customer_phone']),
    payerName,
    tillNumber: pickFirst(d, ['BusinessShortCode', 'business_short_code', 'short_code', 'till_number', 'till']),
    paidAt: parseMpesaTime(pickFirst(d, ['TransTime', 'TransactionDate', 'transaction_date', 'paid_at', 'created_at'])),
  };
}

/** Best-effort receipt backfill source - GET /transaction-status never returns a receipt code, only the callback and this endpoint do. Used when the callback hasn't (yet) arrived. */
async function getAccountTransactions({ credentials, page = 1, per = 20 }) {
  try {
    const res = await axios.get(`${BASE_URL}/transactions`, {
      params: { page, per },
      headers: authHeader(credentials),
      timeout: 15000,
    });
    return res.data; // { transactions: [{ transaction_reference, amount, created_at, ... }], pagination: {...} }
  } catch (err) {
    const msg = err.response?.data?.error_message || err.message;
    throw ApiError.externalService(`PayHero account-transactions check failed: ${msg}`, 'MPESA_TRANSACTIONS_CHECK_FAILED');
  }
}

module.exports = { stkPush, getTransactionStatus, getAccountTransactions, parseCallback, parseInboundPayment, normalizePhone };