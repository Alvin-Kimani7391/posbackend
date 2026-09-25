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

module.exports = { stkPush, getTransactionStatus, getAccountTransactions, parseCallback, normalizePhone };
