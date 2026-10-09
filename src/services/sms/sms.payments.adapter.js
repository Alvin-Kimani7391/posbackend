const payhero = require('../../integrations/mpesa/payhero.provider');
const { decryptJson } = require('../../utils/crypto');
const ApiError = require('../../utils/ApiError');
const settingsSvc = require('../billing.settings');
const { SmsPayment } = require('../../models/sms.models');
const { looksLikeReceipt } = require('../../utils/mpesaMessage');

/** Same credentials + channel the Billing module uses (Admin > Billing > Settings). */
async function stkConfig() {
  const s = await settingsSvc.getWithSecrets();
  if (!s.stk?.enabled || !s.stk.channelId || !s.stk.credentialsBlob) {
    throw ApiError.badRequest('M-PESA prompt is not set up. Save the PayHero details in Admin > Billing > Settings.', 'SMS_STK_UNAVAILABLE');
  }
  return { channelId: s.stk.channelId, credentials: decryptJson(s.stk.credentialsBlob) };
}

/** What the owner UI needs to show payment options (no secrets). */
async function paymentOptions() {
  const s = await settingsSvc.get();
  return {
    stk: { available: !!(s.stk?.enabled && s.stk.channelId && s.stk.credentialsSetAt) },
    manual: {
      available: !!s.manual?.enabled, label: s.manual?.methodLabel, number: s.manual?.number, accountName: s.manual?.accountName,
      accountReference: s.manual?.accountReference, phone: s.manual?.phone, instructions: s.manual?.instructions,
    },
  };
}

async function initiateStk({ amountCents, phone, reference, businessName }) {
  const { channelId, credentials } = await stkConfig();
  const base = String(process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw ApiError.badRequest('The server has no PUBLIC_API_BASE_URL set', 'BILLING_NOT_CONFIGURED');
  const r = await payhero.stkPush({
    credentials, channelId, amountCents, phone, externalReference: reference, customerName: businessName,
    callbackUrl: `${base}/api/v1/sms-hooks/payhero`,
  });
  return { providerRef: r.reference };
}

/** -> { state: 'SUCCESS'|'FAILED'|'PENDING', receipt?, reason? }. Only PayHero's live status is trusted for money. */
async function checkStk(providerRef, amountCents, startedAt) {
  const { credentials } = await stkConfig();
  let live;
  try { live = await payhero.getTransactionStatus({ credentials, reference: providerRef }); } catch (e) { return { state: 'PENDING' }; }
  const s = String(live.status || '').toUpperCase();
  if (s === 'FAILED') return { state: 'FAILED', reason: 'Payment failed or was cancelled on the phone' };
  if (s !== 'SUCCESS') return { state: 'PENDING' };

  let receipt;
  try {
    const { transactions } = await payhero.getAccountTransactions({ credentials, page: 1, per: 20 });
    const kes = Math.round(amountCents / 100);
    const anchor = new Date(startedAt || Date.now()).getTime();
    const hits = (transactions || [])
      .filter((t) => looksLikeReceipt(t.transaction_reference) && Number(t.amount) === kes && ['inbound_payment', 'payment', 'collection'].includes(t.transaction_type))
      .map((t) => ({ code: String(t.transaction_reference).trim().toUpperCase(), d: Math.abs(new Date(t.created_at).getTime() - anchor) }))
      .filter((x) => x.d < 15 * 60 * 1000).sort((a, b) => a.d - b.d);
    for (const h of hits) { if (!(await SmsPayment.exists({ mpesaCode: h.code }))) { receipt = h.code; break; } }
  } catch (e) { /* code is optional; the payment is still valid */ }
  return { state: 'SUCCESS', receipt };
}

/** Hook: write the labelled record into your own billing reports if you want it there. */
async function mirrorToBilling(payment) {
  console.log('[sms] settled', payment.reference, payment.label, payment.amountCents);
}

module.exports = { initiateStk, checkStk, paymentOptions, mirrorToBilling };