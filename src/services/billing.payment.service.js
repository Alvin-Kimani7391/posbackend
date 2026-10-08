const crypto = require('crypto');
const mongoose = require('mongoose');
const Business = require('../models/Business');
const Subscription = require('../models/Subscription');
const SubscriptionPayment = require('../models/SubscriptionPayment');
const ApiError = require('../utils/ApiError');
const { decryptJson } = require('../utils/crypto');
const { parseMpesaMessage, looksLikeReceipt } = require('../utils/mpesaMessage');
const { LIMITS } = require('../constants/billing');
const payhero = require('../integrations/mpesa/payhero.provider');
const settingsSvc = require('./billing.settings');
const notify = require('./billing.notify');
const engine = require('./billing.service');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function stkConfig() {
  const s = await settingsSvc.getWithSecrets();
  if (!s.stk?.enabled || !s.stk.channelId || !s.stk.credentialsBlob) {
    throw ApiError.badRequest('Online M-PESA payment is not available right now. Use manual payment or contact support.', 'BILLING_STK_UNAVAILABLE');
  }
  return { settings: s, channelId: s.stk.channelId, credentials: decryptJson(s.stk.credentialsBlob) };
}

function toClient(p) {
  const o = p.toObject ? p.toObject() : p;
  let message = '';
  if (o.status === 'PENDING') message = 'Waiting for the customer to enter their M-PESA PIN…';
  else if (o.status === 'SUBMITTED') message = 'Submitted - waiting for verification.';
  else if (o.status === 'SUCCESS') message = o.mpesaReceiptNumber ? `Confirmed - M-PESA code ${o.mpesaReceiptNumber}` : 'Confirmed - payment received';
  else if (o.status === 'REJECTED') message = o.review?.note || 'Payment was not approved.';
  else message = o.resultDesc || 'Payment was not completed.';
  return {
    id: o._id, method: o.method, status: o.status, amount: o.amount, claimedAmount: o.claimedAmount, reference: o.reference,
    mpesaReceiptNumber: o.mpesaReceiptNumber || null, failureType: o.failureType || null, message,
    createdAt: o.createdAt, settledAt: o.settledAt || null, allocations: o.allocations || [], creditAddedCents: o.creditAddedCents || 0,
  };
}

/* ----------------------------- STK push ----------------------------- */

async function initiateStk(businessId, user, { phone, amountCents }) {
  const sub = await Subscription.findOne({ businessId });
  if (!sub) throw ApiError.notFound('No subscription found for this business');
  if (sub.status === 'CANCELLED') throw ApiError.badRequest('This subscription is cancelled. Contact support.', 'SUBSCRIPTION_CANCELLED');

  const { channelId, credentials } = await stkConfig();
  const base = String(process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw ApiError.badRequest('The server has no PUBLIC_API_BASE_URL set', 'BILLING_NOT_CONFIGURED');

  const inFlight = await SubscriptionPayment.findOne({
    businessId, method: 'STK', status: 'PENDING', createdAt: { $gte: new Date(Date.now() - LIMITS.STK_TIMEOUT_MS) },
  });
  if (inFlight) throw ApiError.conflict('A payment prompt is already waiting on the phone. Let it finish first.', 'BILLING_PAYMENT_IN_PROGRESS');

  const business = await Business.findById(businessId).select('name').lean();
  const reference = `BLP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const callbackToken = crypto.randomBytes(24).toString('hex');
  const payment = await SubscriptionPayment.create({
    businessId, subscriptionId: sub._id, initiatedBy: user._id, source: 'OWNER', method: 'STK', status: 'PENDING',
    amount: amountCents, claimedAmount: amountCents, reference, callbackToken, phone: payhero.normalizePhone(phone),
  });

  try {
    const result = await payhero.stkPush({
      credentials, channelId, amountCents, phone, externalReference: reference,
      customerName: business?.name, callbackUrl: `${base}/api/v1/billing/callback/${payment._id}/${callbackToken}`,
    });
    payment.checkoutRequestId = result.checkoutRequestId;
    payment.providerReference = result.reference;
    payment.rawInitiateResponse = result.raw;
    await payment.save();
    return payment;
  } catch (err) {
    payment.status = 'FAILED'; payment.failureType = err.mpesaFailureType || 'send_failed'; payment.resultDesc = err.message;
    await payment.save();
    throw err;
  }
}

async function markFailed(paymentId, failureType, desc) {
  await SubscriptionPayment.updateOne({ _id: paymentId, status: 'PENDING' }, { $set: { status: 'FAILED', failureType, resultDesc: desc } });
}

async function attachReceipt(paymentId, code) {
  try {
    await SubscriptionPayment.updateOne({ _id: paymentId }, { $set: { mpesaReceiptNumber: code, receiptKey: code } });
  } catch (err) {
    if (err.code !== 11000) throw err;
    // Same code already belongs to another payment: keep it for display, flag it, never double-key it.
    await SubscriptionPayment.updateOne({ _id: paymentId }, { $set: { mpesaReceiptNumber: code }, $addToSet: { flags: 'DUPLICATE_RECEIPT' } });
  }
}

/** Best effort: find the M-PESA code of a settled STK payment in PayHero's ledger (blocks re-submitting it as a "manual" payment). */
async function backfillReceipt(paymentId) {
  const p = await SubscriptionPayment.findById(paymentId);
  if (!p || p.mpesaReceiptNumber || p.status !== 'SUCCESS') return;
  const { credentials } = await stkConfig();
  const { transactions } = await payhero.getAccountTransactions({ credentials, page: 1, per: 20 });
  if (!Array.isArray(transactions)) return;
  const anchor = (p.settledAt || p.createdAt).getTime();
  const kes = Math.round(p.amount / 100);
  const hit = transactions
    .filter((t) => looksLikeReceipt(t.transaction_reference) && Number(t.amount) === kes && ['inbound_payment', 'payment', 'collection'].includes(t.transaction_type))
    .map((t) => ({ t, d: Math.abs(new Date(t.created_at).getTime() - anchor) }))
    .filter((x) => x.d < 15 * 60 * 1000)
    .sort((a, b) => a.d - b.d)[0];
  if (hit) await attachReceipt(paymentId, hit.t.transaction_reference.trim().toUpperCase());
}

/** The ONLY place an STK payment becomes SUCCESS. Atomic, so callback + poll + job can race safely. */
async function settleStk(paymentId, receiptHint) {
  const prior = await SubscriptionPayment.findOneAndUpdate(
    { _id: paymentId, method: 'STK', status: { $in: ['PENDING', 'FAILED'] } },
    { $set: { status: 'SUCCESS', settledAt: new Date(), failureType: '', resultDesc: 'Payment confirmed' } },
    { new: false }
  );
  if (!prior) return null; // already settled by someone else

  if (prior.status === 'FAILED') {
    await notify.adminAlert({ subject: 'Late STK payment recovered', paragraphs: [`Payment ${prior.reference} had timed out but PayHero later confirmed it. It has now been credited.`] });
  }
  const code = receiptHint && looksLikeReceipt(receiptHint) ? receiptHint.trim().toUpperCase() : null;
  if (code) await attachReceipt(paymentId, code);
  const done = await engine.allocatePayment(paymentId);
  if (!code) backfillReceipt(paymentId).catch((e) => console.error('[billing] receipt backfill failed', e.message));
  return done;
}

/** Asks PayHero directly. The callback body is never trusted for money - only this live check is. */
async function verifyStk(payment, { force = false, receiptHint = null } = {}) {
  if (payment.method !== 'STK') return payment;
  const age = Date.now() - payment.createdAt.getTime();
  const lateRecheck = payment.status === 'FAILED' && payment.failureType === 'timeout' && age < LIMITS.LATE_SUCCESS_WINDOW_MS;
  if (payment.status !== 'PENDING' && !lateRecheck) return payment;
  if (!force && payment.lastCheckedAt && Date.now() - payment.lastCheckedAt.getTime() < 4000) return payment;

  if (!payment.providerReference) {
    if (payment.status === 'PENDING' && age > LIMITS.STK_TIMEOUT_MS) await markFailed(payment._id, 'timeout', 'No response received in time');
    return SubscriptionPayment.findById(payment._id);
  }

  let live = null;
  try {
    const { credentials } = await stkConfig();
    live = await payhero.getTransactionStatus({ credentials, reference: payment.providerReference });
  } catch (err) {
    console.error('[billing] live status check failed', { reference: payment.reference, error: err.message });
  }
  await SubscriptionPayment.updateOne({ _id: payment._id }, { $set: { lastCheckedAt: new Date() } });

  if (live?.status === 'SUCCESS') await settleStk(payment._id, receiptHint);
  else if (live?.status === 'FAILED' && payment.status === 'PENDING') await markFailed(payment._id, 'failed', 'Payment failed or was cancelled');
  else if (payment.status === 'PENDING' && age > LIMITS.STK_TIMEOUT_MS) await markFailed(payment._id, 'timeout', 'No response received from the customer in time');
  return SubscriptionPayment.findById(payment._id);
}

async function getPaymentStatus(businessId, paymentId) {
  if (!mongoose.isValidObjectId(paymentId)) throw ApiError.notFound('Payment not found');
  const payment = await SubscriptionPayment.findOne({ _id: paymentId, businessId });
  if (!payment) throw ApiError.notFound('Payment not found');
  return toClient(await verifyStk(payment));
}

/** PUBLIC webhook. Returns { forbidden: true } for a bad token, otherwise processes (after a live verification). */
async function handleCallback(paymentId, token, body) {
  if (!mongoose.isValidObjectId(paymentId) || typeof token !== 'string' || !token) return { forbidden: true };
  const payment = await SubscriptionPayment.findById(paymentId).select('+callbackToken');
  if (!payment || !payment.callbackToken || !safeEqual(token, payment.callbackToken)) return { forbidden: true };

  await SubscriptionPayment.updateOne({ _id: payment._id }, { $set: { rawCallback: body } });
  const parsed = payhero.parseCallback(body);
  const hint = looksLikeReceipt(parsed.mpesaReceiptNumber) ? parsed.mpesaReceiptNumber : null;
  await verifyStk(payment, { force: true, receiptHint: hint });
  return { processed: true };
}

/* ------------------------- manual (pasted SMS) ------------------------- */

async function submitManual(businessId, user, { mpesaMessage, amountCents }) {
  const settings = await settingsSvc.get();
  if (!settings.manual?.enabled) throw ApiError.badRequest('Manual payment is not available right now.', 'BILLING_MANUAL_DISABLED');
  const sub = await Subscription.findOne({ businessId });
  if (!sub) throw ApiError.notFound('No subscription found for this business');

  const parsed = parseMpesaMessage(mpesaMessage);
  if (!parsed.code) throw ApiError.badRequest('Paste the full M-PESA confirmation message (it starts with a 10-character code and the word "Confirmed").', 'MPESA_MESSAGE_INVALID');

  if (await SubscriptionPayment.exists({ receiptKey: parsed.code })) {
    throw ApiError.conflict('That M-PESA code has already been submitted.', 'MPESA_ALREADY_SUBMITTED');
  }
  const pending = await SubscriptionPayment.countDocuments({ businessId, method: 'MPESA_MANUAL', status: 'SUBMITTED' });
  if (pending >= LIMITS.MAX_PENDING_MANUAL) throw ApiError.badRequest('You already have several payments waiting for verification. Please wait for them to be reviewed.', 'TOO_MANY_PENDING');

  let amount = parsed.amountCents;
  if (amount != null && amountCents != null && amount !== amountCents) {
    throw ApiError.badRequest('The amount you entered does not match the amount in the M-PESA message.', 'MPESA_AMOUNT_MISMATCH');
  }
  if (amount == null) amount = amountCents;
  if (!amount || amount <= 0 || amount > LIMITS.MANUAL_MAX_CENTS) throw ApiError.badRequest('Enter the amount you paid.', 'AMOUNT_REQUIRED');

  const flags = [];
  if (parsed.amountCents == null) flags.push('AMOUNT_NOT_IN_MESSAGE');
  if (parsed.looksReceived) flags.push('LOOKS_LIKE_RECEIVED_MESSAGE');
  const targets = [settings.manual.number, settings.manual.accountName, settings.manual.phone].filter(Boolean).map((s) => String(s).toUpperCase().replace(/\s+/g, ''));
  const hay = parsed.text.toUpperCase().replace(/\s+/g, '');
  if (targets.length && !targets.some((t) => hay.includes(t))) flags.push('RECIPIENT_NOT_FOUND');
  if (await SubscriptionPayment.exists({ businessId, method: 'STK', status: 'SUCCESS', amount, createdAt: { $gte: new Date(Date.now() - 48 * 3600 * 1000) } })) flags.push('SIMILAR_RECENT_STK');

  let payment;
  try {
    payment = await SubscriptionPayment.create({
      businessId, subscriptionId: sub._id, initiatedBy: user._id, source: 'OWNER', method: 'MPESA_MANUAL', status: 'SUBMITTED',
      amount, claimedAmount: amount, reference: `BLM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      mpesaReceiptNumber: parsed.code, receiptKey: parsed.code, mpesaMessage: parsed.text.slice(0, 1000),
      parsed: { code: parsed.code, amountCents: parsed.amountCents, recipient: parsed.recipient }, flags,
    });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('That M-PESA code has already been submitted.', 'MPESA_ALREADY_SUBMITTED');
    throw err;
  }
  const business = await Business.findById(businessId).select('name').lean();
  await notify.manualSubmitted(payment, business?.name);
  return payment;
}

async function approveManual(admin, paymentId, { amountCents, note }) {
  const p = await SubscriptionPayment.findById(paymentId);
  if (!p || p.method !== 'MPESA_MANUAL') throw ApiError.notFound('Payment not found');
  if (p.status !== 'SUBMITTED') throw ApiError.conflict('This payment is not waiting for review.', 'PAYMENT_NOT_PENDING_REVIEW');

  const amount = amountCents ?? p.claimedAmount;
  if (!Number.isInteger(amount) || amount <= 0 || amount > LIMITS.MANUAL_MAX_CENTS) throw ApiError.badRequest('Enter a valid verified amount.', 'AMOUNT_INVALID');

  const updated = await SubscriptionPayment.findOneAndUpdate(
    { _id: paymentId, status: 'SUBMITTED' },
    { $set: { status: 'SUCCESS', amount, settledAt: new Date(), review: { by: admin._id, byName: admin.name, at: new Date(), note: note || '' } } },
    { new: true }
  );
  if (!updated) throw ApiError.conflict('Someone else just reviewed this payment.', 'PAYMENT_NOT_PENDING_REVIEW');
  await notify.event(updated.businessId, 'MANUAL_APPROVED', `Manual payment ${updated.mpesaReceiptNumber} approved for ${amount} cents`, { paymentId: updated._id, actorId: admin._id, actorName: admin.name });
  await engine.allocatePayment(updated._id);
  return SubscriptionPayment.findById(updated._id);
}

async function rejectManual(admin, paymentId, { reason }) {
  const updated = await SubscriptionPayment.findOneAndUpdate(
    { _id: paymentId, method: 'MPESA_MANUAL', status: 'SUBMITTED' },
    { $set: { status: 'REJECTED', settledAt: new Date(), review: { by: admin._id, byName: admin.name, at: new Date(), note: reason } }, $unset: { receiptKey: 1 } },
    { new: true }
  );
  if (!updated) throw ApiError.conflict('This payment is not waiting for review.', 'PAYMENT_NOT_PENDING_REVIEW');
  await notify.event(updated.businessId, 'MANUAL_REJECTED', `Manual payment ${updated.mpesaReceiptNumber} rejected: ${reason}`, { paymentId: updated._id, actorId: admin._id, actorName: admin.name });
  await notify.manualRejected(updated, reason);
  return updated;
}

module.exports = { toClient, initiateStk, verifyStk, getPaymentStatus, handleCallback, settleStk, submitManual, approveManual, rejectManual };