const crypto = require('crypto');
const mongoose = require('mongoose');
const MpesaTransaction = require('../models/MpesaTransaction');
const MpesaInboundPayment = require('../models/MpesaInboundPayment');
const IntegrationSettings = require('../models/IntegrationSettings');
const Payment = require('../models/Payment');
const Receipt = require('../models/Receipt');
const AuditLog = require('../models/AuditLog');
const { decryptJson } = require('../utils/crypto');
const { ROLES } = require('../constants/roles');
const payhero = require('../integrations/mpesa/payhero.provider');
const { interpretMpesaResult } = require('../utils/mpesaErrors');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

const COOLDOWN_AFTER_FAILURES = 3;
const COOLDOWN_WINDOW_MS = 2 * 60 * 1000;
const COOLDOWN_DURATION_MS = 60 * 1000;
const PENDING_TIMEOUT_MS = 90 * 1000;
const HARD_ESCALATE_MS = 10 * 60 * 1000;
const RECEIPT_BACKFILL_WINDOW_MS = 15 * 60 * 1000; // how close (in time) an account-transactions entry must be to count as a match
const RECEIPT_BACKFILL_MAX_AGE_MS = 30 * 60 * 1000; // stop trying to backfill a SUCCESS txn older than this - the callback isn't coming, and PayHero's transactions list won't stay a reliable match forever

// --- Manual (Buy Goods / Till) payments ---
const MANUAL_PENDING_TIMEOUT_MS = 5 * 60 * 1000; // how long a cashier waits for the customer to pay the till
const MANUAL_LOOKBACK_MS = 30 * 1000; // a till payment may have landed this long BEFORE the cashier tapped "start"
const INBOUND_ESCALATE_MS = 10 * 60 * 1000; // tell management about a till payment nobody claimed after this long

// Safaricom M-Pesa receipt codes are always exactly 10 characters: one
// letter followed by 9 alphanumeric characters, all uppercase. Anything
// that doesn't match this is NOT a receipt code - a wrong code on a
// receipt is worse than a missing one, so this gate is never bypassed,
// callback or backfill alike.
const MPESA_RECEIPT_PATTERN = /^[A-Z][A-Z0-9]{9}$/;

function looksLikeMpesaReceipt(code) {
  return typeof code === 'string' && MPESA_RECEIPT_PATTERN.test(code.trim().toUpperCase());
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function loadMpesaConfig(businessId) {
  const settings = await IntegrationSettings.findOne({ businessId }).select('+mpesa.credentialsBlob');
  if (!settings?.mpesa?.enabled) throw ApiError.badRequest('M-PESA is not enabled for this business', 'MPESA_NOT_ENABLED');
  if (!settings.mpesa.credentialsBlob || !settings.mpesa.channelId) {
    throw ApiError.badRequest('M-PESA is enabled but not fully configured. Ask the owner to finish setup.', 'MPESA_NOT_CONFIGURED');
  }
  return { channelId: settings.mpesa.channelId, credentials: decryptJson(settings.mpesa.credentialsBlob) };
}

async function assertNotCoolingDown(businessId, branchId) {
  // Only STK attempts count toward the failure cooldown; manual till requests never hit PayHero's STK API.
  const recent = await MpesaTransaction.find({
    businessId, branchId, channel: { $ne: 'MANUAL' }, createdAt: { $gte: new Date(Date.now() - COOLDOWN_WINDOW_MS) },
  }).sort({ createdAt: -1 }).limit(COOLDOWN_AFTER_FAILURES);

  if (recent.length < COOLDOWN_AFTER_FAILURES) return;
  const allFailed = recent.every((t) => t.status === 'FAILED');
  if (!allFailed) return;

  const mostRecentFailureAt = recent[0].updatedAt.getTime();
  const cooldownUntil = mostRecentFailureAt + COOLDOWN_DURATION_MS;
  if (Date.now() < cooldownUntil) {
    const waitSeconds = Math.ceil((cooldownUntil - Date.now()) / 1000);
    throw ApiError.badRequest(`Too many failed M-PESA attempts on this till. Wait ${waitSeconds}s and try again.`, 'MPESA_COOLDOWN');
  }
}

async function initiateStk(businessId, branchId, user, { phone, amountCents, customerName }) {
  await assertNotCoolingDown(businessId, branchId);
  const { channelId, credentials } = await loadMpesaConfig(businessId);
  const reference = `MPX-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  const txn = await MpesaTransaction.create({
    businessId, branchId, initiatedBy: user._id,
    reference, phone: payhero.normalizePhone(phone), amount: amountCents,
    channel: 'STK',
    status: 'PENDING',
  });

  try {
    const callbackUrl = `${process.env.PUBLIC_API_BASE_URL}/api/v1/payments/mpesa/callback/${businessId}`;
    const result = await payhero.stkPush({ credentials, channelId, amountCents, phone, externalReference: reference, customerName, callbackUrl });
    txn.checkoutRequestId = result.checkoutRequestId;
    txn.providerReference = result.reference;
    txn.rawInitiateResponse = result.raw;
    await txn.save();
    return txn;
  } catch (err) {
    txn.status = 'FAILED';
    txn.failureType = err.mpesaFailureType || 'send_failed';
    txn.resultDesc = err.message;
    await txn.save();
    throw err;
  }
}

function toClientShape(txn, extra = {}) {
  const isManual = txn.channel === 'MANUAL';
  const successMessage = txn.mpesaReceiptNumber
    ? `Confirmed - M-PESA receipt ${txn.mpesaReceiptNumber}`
    : 'Confirmed - payment received';

  let message;
  if (txn.status === 'SUCCESS') message = successMessage;
  else if (txn.status === 'PENDING') {
    message = isManual ? 'Waiting for the customer to pay to the Till number…' : 'Waiting for the customer to enter their PIN…';
  } else if (isManual) message = txn.resultDesc || 'Payment was not completed.';
  else message = (txn.resultDesc && interpretMpesaResult(txn.resultCode, txn.resultDesc).message) || 'Payment was not completed.';

  return {
    reference: txn.reference,
    status: txn.status,
    failureType: txn.failureType || null,
    message,
    amount: txn.amount,
    mpesaReceiptNumber: txn.mpesaReceiptNumber || null,
    channel: txn.channel || 'STK',
    needsCode: !!extra.needsCode, // MANUAL only: automatic matching is ambiguous, ask the cashier for the customer's M-PESA code
  };
}

/** Pushes a resolved receipt number onto the Payment/Receipt already created for this MpesaTransaction's sale, if any. Safe to call multiple times - a no-op once already applied. */
async function propagateReceiptToPaymentAndReceipt(txn) {
  if (!txn.saleId || !txn.mpesaReceiptNumber) return;
  await Payment.updateOne(
    { saleId: txn.saleId, method: 'MPESA', reference: txn.reference },
    { externalTransactionId: txn.mpesaReceiptNumber }
  );
  await Receipt.updateOne(
    { saleId: txn.saleId, 'receiptData.payments.reference': txn.reference },
    { $set: { 'receiptData.payments.$.externalTransactionId': txn.mpesaReceiptNumber } }
  );
}

/**
 * sealInboundForStk - once an STK push learns its receipt code, make sure the same code can never
 * also be claimed as a till payment (PayHero's ledger lists both kinds side by side).
 */
async function sealInboundForStk(txn) {
  if (!txn.mpesaReceiptNumber) return;
  try {
    await MpesaInboundPayment.updateOne(
      { businessId: txn.businessId, mpesaReceiptNumber: txn.mpesaReceiptNumber, status: 'UNCLAIMED' },
      { $set: { status: 'CLAIMED', claimedByReference: txn.reference, claimedAt: new Date() } }
    );
  } catch (err) {
    console.error('[mpesa] sealInboundForStk failed', { reference: txn.reference, error: err.message });
  }
}

/**
 * backfillReceiptNumber - fallback source of the M-PESA receipt code when
 * the callback hasn't (yet) supplied one. PayHero's GET /transaction-status
 * never returns a receipt code, but GET /transactions (their account
 * ledger) includes `transaction_reference`, which for an STK collection IS
 * the M-PESA receipt code. There's no field in that list that maps
 * directly back to our own reference/checkoutRequestId, so matching is
 * done by amount + time proximity - best-effort, not guaranteed, and
 * skipped once the transaction is too old for that matching to stay safe.
 * Never overwrites a receipt number a real callback already supplied.
 */
async function backfillReceiptNumber(txn, credentials) {
  if (txn.mpesaReceiptNumber || txn.status !== 'SUCCESS') return;
  if (Date.now() - txn.createdAt.getTime() > RECEIPT_BACKFILL_MAX_AGE_MS) return;

  try {
    const { transactions } = await payhero.getAccountTransactions({ credentials, page: 1, per: 20 });
    if (!Array.isArray(transactions) || !transactions.length) return;

    const anchorTime = (txn.lastCheckedAt || txn.updatedAt || txn.createdAt).getTime();
    const expectedAmount = Math.round(txn.amount / 100); // whole KES, same unit PayHero's `amount` field uses

    const candidates = transactions
      .filter((t) => t.transaction_reference && looksLikeMpesaReceipt(t.transaction_reference))
      .filter((t) => Number(t.amount) === expectedAmount)
      // Only money coming IN, never a fee/charge/withdrawal row - those
      // never carry the customer's own M-Pesa code and must never be
      // mistaken for it.
      .filter((t) => ['inbound_payment', 'payment', 'collection'].includes(t.transaction_type))
      .map((t) => ({ t, deltaMs: Math.abs(new Date(t.created_at).getTime() - anchorTime) }))
      .filter(({ deltaMs }) => deltaMs < RECEIPT_BACKFILL_WINDOW_MS)
      .sort((a, b) => a.deltaMs - b.deltaMs);

    if (!candidates.length) return; // no confident, correctly-shaped match - leave it blank, never guess
    const receiptCode = candidates[0].t.transaction_reference.trim().toUpperCase();

    // Guard against the (rare) case of two different sales for the same
    // amount within the matching window - never assign a code another
    // MpesaTransaction has already claimed.
    const alreadyUsed = await MpesaTransaction.exists({ mpesaReceiptNumber: receiptCode, _id: { $ne: txn._id } });
    if (alreadyUsed) return;

    // Same guard for till payments: a code that arrived as a Buy Goods payment belongs to
    // the manual flow, never to an STK push that merely has the same amount.
    const isTillPayment = await MpesaInboundPayment.exists({ businessId: txn.businessId, mpesaReceiptNumber: receiptCode });
    if (isTillPayment) return;

    txn.mpesaReceiptNumber = receiptCode;
    await txn.save();
    await sealInboundForStk(txn);
    await propagateReceiptToPaymentAndReceipt(txn);
  } catch (err) {
    console.error('[mpesa] receipt backfill failed', { reference: txn.reference, error: err.message });
  }
}

/* ====================================================================== *
 * MANUAL (Buy Goods / Till) payments
 * ====================================================================== */

/** Starts a wait-for-till-payment request. No PayHero call: the customer pays the till on their own. */
async function initiateManual(businessId, branchId, user, { amountCents }) {
  const settings = await IntegrationSettings.findOne({ businessId });
  if (!settings?.mpesa?.manualEnabled || !settings.mpesa.tillNumber) {
    throw ApiError.badRequest('Manual M-PESA (Till) payments are not enabled for this business. Ask the owner to set them up.', 'MPESA_MANUAL_NOT_ENABLED');
  }

  // A cashier who restarts must not leave a stale request behind: two pending requests for the
  // same amount would make automatic matching ambiguous for everyone.
  await MpesaTransaction.updateMany(
    { businessId, branchId, initiatedBy: user._id, channel: 'MANUAL', status: 'PENDING' },
    { $set: { status: 'CANCELLED', failureType: 'cancelled', resultDesc: 'Replaced by a newer request' } }
  );

  const reference = `MPM-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  return MpesaTransaction.create({
    businessId, branchId, initiatedBy: user._id,
    reference, channel: 'MANUAL', tillNumber: settings.mpesa.tillNumber,
    amount: amountCents, status: 'PENDING',
  });
}

/** Till payments that could pay for this request: unclaimed, EXACT amount, received (by our clock) no earlier than the lookback window, and whose code no STK push already owns. */
async function findManualCandidates(txn) {
  const since = new Date(txn.createdAt.getTime() - MANUAL_LOOKBACK_MS);
  const found = await MpesaInboundPayment.find({
    businessId: txn.businessId, status: 'UNCLAIMED', amount: txn.amount, createdAt: { $gte: since },
  }).sort({ createdAt: 1 }).limit(5);

  const usable = [];
  for (const c of found) {
    const usedByStk = await MpesaTransaction.exists({ businessId: txn.businessId, mpesaReceiptNumber: c.mpesaReceiptNumber });
    if (!usedByStk) usable.push(c);
  }
  return usable;
}

/**
 * claimInbound - the ONLY place a till payment becomes a confirmed MpesaTransaction.
 * Step 1 atomically flips UNCLAIMED -> CLAIMED (so two requests can never take the same
 * payment). Step 2 atomically flips the request PENDING -> SUCCESS. If step 2 loses a race
 * (request timed out / cancelled meanwhile) step 1 is undone so the payment is not lost.
 */
async function claimInbound(inbound, txn) {
  const claimed = await MpesaInboundPayment.findOneAndUpdate(
    { _id: inbound._id, status: 'UNCLAIMED' },
    { $set: { status: 'CLAIMED', claimedByReference: txn.reference, claimedAt: new Date() } },
    { new: true }
  );
  if (!claimed) return false;

  const set = {
    status: 'SUCCESS', failureType: '', resultDesc: 'Till payment matched',
    mpesaReceiptNumber: claimed.mpesaReceiptNumber, matchedInboundId: claimed._id, lastCheckedAt: new Date(),
  };
  if (claimed.payerPhone) set.phone = String(claimed.payerPhone);

  let updated = null;
  try {
    updated = await MpesaTransaction.findOneAndUpdate(
      { _id: txn._id, channel: 'MANUAL', status: 'PENDING', amount: claimed.amount },
      { $set: set },
      { new: true }
    );
  } catch (err) {
    console.error('[mpesa manual] request update failed, releasing payment', { reference: txn.reference, error: err.message });
  }

  if (!updated) {
    await MpesaInboundPayment.updateOne(
      { _id: claimed._id, claimedByReference: txn.reference },
      { $set: { status: 'UNCLAIMED' }, $unset: { claimedByReference: 1, claimedAt: 1 } }
    );
    return false;
  }
  return true;
}

/**
 * tryAutoMatch - automatic matching is only done when it is UNAMBIGUOUS:
 *   - exactly one pending manual request for this amount in the business, and
 *   - exactly one unclaimed till payment for this amount.
 * Anything else returns needsCode:true so the cashier confirms with the customer's M-PESA code.
 */
async function tryAutoMatch(txn) {
  const competing = await MpesaTransaction.countDocuments({
    businessId: txn.businessId, channel: 'MANUAL', status: 'PENDING', amount: txn.amount,
    createdAt: { $gte: new Date(Date.now() - MANUAL_PENDING_TIMEOUT_MS) },
  });
  if (competing > 1) return { matched: false, needsCode: true };

  const candidates = await findManualCandidates(txn);
  if (candidates.length === 0) return { matched: false, needsCode: false };
  if (candidates.length > 1) return { matched: false, needsCode: true };

  const matched = await claimInbound(candidates[0], txn);
  return { matched, needsCode: false };
}

/** Push-style matching, run right when a till payment arrives (so the POS does not wait for the next poll). */
async function matchPendingForInbound(inbound) {
  const pending = await MpesaTransaction.find({
    businessId: inbound.businessId, channel: 'MANUAL', status: 'PENDING', amount: inbound.amount,
    createdAt: { $gte: new Date(Date.now() - MANUAL_PENDING_TIMEOUT_MS) },
  }).limit(2);
  if (pending.length !== 1) return false;
  const result = await tryAutoMatch(pending[0]);
  return result.matched;
}

/**
 * ingestInboundPayment - PUBLIC webhook handler for "a customer paid the till".
 * Trust gates, in order: secret URL token (constant-time) -> manual enabled -> parsable ->
 * not an STK echo -> success -> money IN -> valid M-PESA receipt code -> positive amount ->
 * till number matches (when the payload carries one) -> unique receipt code (retries are no-ops).
 */
async function ingestInboundPayment(businessId, token, body) {
  if (!mongoose.isValidObjectId(businessId) || typeof token !== 'string' || !token) {
    throw ApiError.forbidden('Invalid webhook', 'WEBHOOK_FORBIDDEN');
  }
  const settings = await IntegrationSettings.findOne({ businessId }).select('+mpesa.webhookToken');
  if (!settings?.mpesa?.manualEnabled || !settings.mpesa.webhookToken || !safeEqual(token, settings.mpesa.webhookToken)) {
    throw ApiError.forbidden('Invalid webhook', 'WEBHOOK_FORBIDDEN');
  }

  const parsed = payhero.parseInboundPayment(body);
  if (!parsed) return { ignored: 'unparsable' };
  if (parsed.isStk) return { ignored: 'stk_push_notification' };
  if (!parsed.success) return { ignored: 'not_successful' };
  if (!parsed.isInbound) return { ignored: 'not_inbound_money' };
  if (!looksLikeMpesaReceipt(parsed.receiptNumber)) return { ignored: 'no_valid_receipt_code' };
  if (!parsed.amountCents) return { ignored: 'no_valid_amount' };

  const configuredTill = String(settings.mpesa.tillNumber || '').replace(/\D/g, '');
  const payloadTill = String(parsed.tillNumber || '').replace(/\D/g, '');
  if (configuredTill && payloadTill && configuredTill !== payloadTill) return { ignored: 'different_till' };

  const code = parsed.receiptNumber.trim().toUpperCase();
  const usedByStk = await MpesaTransaction.findOne({ businessId, mpesaReceiptNumber: code }).select('reference');

  let inbound;
  try {
    inbound = await MpesaInboundPayment.create({
      businessId,
      mpesaReceiptNumber: code,
      amount: parsed.amountCents,
      payerPhone: parsed.payerPhone ? String(parsed.payerPhone) : undefined,
      payerName: parsed.payerName || undefined,
      tillNumber: parsed.tillNumber ? String(parsed.tillNumber) : configuredTill || undefined,
      paidAt: parsed.paidAt || undefined,
      status: usedByStk ? 'CLAIMED' : 'UNCLAIMED',
      claimedByReference: usedByStk ? usedByStk.reference : undefined,
      claimedAt: usedByStk ? new Date() : undefined,
      rawPayload: body,
    });
  } catch (err) {
    if (err && err.code === 11000) return { duplicate: true }; // PayHero retried - already stored
    throw err;
  }

  let matched = false;
  if (inbound.status === 'UNCLAIMED') {
    try {
      matched = await matchPendingForInbound(inbound);
    } catch (err) {
      console.error('[mpesa manual] immediate match failed (polling will retry)', { code, error: err.message });
    }
  }
  return { stored: true, matched };
}

/** Resolves a MANUAL request: tries to match, then times it out if it has waited too long. */
async function resolveManual(txn) {
  if (txn.status !== 'PENDING') return { txn, needsCode: false };

  let needsCode = false;
  const result = await tryAutoMatch(txn);
  if (!result.matched) needsCode = result.needsCode;

  let fresh = await MpesaTransaction.findById(txn._id);
  if (fresh && fresh.status === 'PENDING' && Date.now() - fresh.createdAt.getTime() > MANUAL_PENDING_TIMEOUT_MS) {
    await MpesaTransaction.updateOne(
      { _id: fresh._id, status: 'PENDING' },
      { $set: { status: 'FAILED', failureType: 'timeout', resultDesc: 'No payment received in time', lastCheckedAt: new Date() } }
    );
    fresh = await MpesaTransaction.findById(txn._id);
  }
  const current = fresh || txn;
  return { txn: current, needsCode: current.status === 'PENDING' && needsCode };
}

async function cancelManual(businessId, reference) {
  const cancelled = await MpesaTransaction.findOneAndUpdate(
    { businessId, reference, channel: 'MANUAL', status: 'PENDING' },
    { $set: { status: 'CANCELLED', failureType: 'cancelled', resultDesc: 'Cancelled by cashier' } },
    { new: true }
  );
  if (cancelled) return toClientShape(cancelled);
  const existing = await MpesaTransaction.findOne({ businessId, reference });
  if (!existing) throw ApiError.notFound('M-PESA transaction not found');
  return toClientShape(existing); // already resolved - report its real state, never pretend it was cancelled
}

/**
 * claimByCode - cashier types the M-PESA code from the customer's confirmation SMS. The code is NEVER
 * trusted by itself: it must exist in our inbox of payments PayHero reported, be unclaimed, and be for
 * exactly this request's amount.
 */
async function claimByCode(businessId, reference, user, receiptCode) {
  const code = String(receiptCode || '').trim().toUpperCase();
  if (!looksLikeMpesaReceipt(code)) throw ApiError.badRequest('Enter the 10-character M-PESA code from the customer\u2019s SMS', 'MPESA_CODE_INVALID');

  const txn = await MpesaTransaction.findOne({ businessId, reference, channel: 'MANUAL' });
  if (!txn) throw ApiError.notFound('M-PESA transaction not found');
  if (txn.status === 'SUCCESS') return toClientShape(txn);
  if (txn.status !== 'PENDING') throw ApiError.badRequest('This payment request is no longer waiting. Start a new one.', 'MPESA_REQUEST_NOT_PENDING');

  const inbound = await MpesaInboundPayment.findOne({ businessId, mpesaReceiptNumber: code });
  if (!inbound) {
    throw ApiError.badRequest('That payment has not been reported to us yet. Wait a few seconds and try again, or check the code.', 'MPESA_CODE_NOT_FOUND');
  }
  if (inbound.status !== 'UNCLAIMED') throw ApiError.conflict('That M-PESA code has already been used', 'MPESA_ALREADY_CONSUMED');
  if (inbound.amount !== txn.amount) {
    throw ApiError.badRequest(
      `That payment was KSh ${(inbound.amount / 100).toFixed(2)} but this sale needs KSh ${(txn.amount / 100).toFixed(2)}. The amounts must match exactly.`,
      'MPESA_AMOUNT_MISMATCH'
    );
  }
  const usedByStk = await MpesaTransaction.exists({ businessId, mpesaReceiptNumber: code });
  if (usedByStk) throw ApiError.conflict('That M-PESA code has already been used', 'MPESA_ALREADY_CONSUMED');

  const ok = await claimInbound(inbound, txn);
  if (!ok) throw ApiError.conflict('Could not confirm that payment - it may have just been used. Try again.', 'MPESA_CLAIM_FAILED');

  try {
    await AuditLog.create({
      businessId, branchId: txn.branchId, userId: user._id, action: 'mpesa.manual.claim_by_code',
      entityType: 'MpesaTransaction', entityId: txn._id, newValue: { reference, receipt: code, amount: txn.amount },
    });
  } catch (err) {
    console.error('[mpesa manual] audit log failed', err.message);
  }

  const fresh = await MpesaTransaction.findById(txn._id);
  return toClientShape(fresh);
}

/* ---- Owner-only setup for the manual (Till) option ---- */

function assertOwner(user) {
  if (!user || user.role !== ROLES.OWNER) {
    throw ApiError.forbidden('Only the business owner can configure payment integrations', 'OWNER_ONLY');
  }
}

function buildWebhookUrl(businessId, token) {
  const base = String(process.env.PUBLIC_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/api/v1/payments/mpesa/c2b/${businessId}/${token}`;
}
 
async function getManualSetup(businessId, user) {
  assertOwner(user);
  const [settings, unclaimedCount, last] = await Promise.all([
    IntegrationSettings.findOne({ businessId }).select('+mpesa.webhookToken'),
    MpesaInboundPayment.countDocuments({ businessId, status: 'UNCLAIMED' }),
    MpesaInboundPayment.findOne({ businessId }).sort({ createdAt: -1 }).select('createdAt amount'),
  ]);
  const token = settings?.mpesa?.webhookToken;
  return {
    enabled: !!settings?.mpesa?.manualEnabled,
    tillNumber: settings?.mpesa?.tillNumber || null,
    webhookUrl: token ? buildWebhookUrl(businessId, token) : null,
    baseUrlConfigured: !!String(process.env.PUBLIC_API_BASE_URL || '').trim(),
    unclaimedCount,
    lastReceivedAt: last ? last.createdAt : null,
    lastReceivedAmount: last ? last.amount : null, // integer cents
  };
}
 
async function updateManualSetup(businessId, user, { enabled, tillNumber, regenerateToken }) {
  assertOwner(user);
  await IntegrationSettings.updateOne({ businessId }, { $setOnInsert: { businessId } }, { upsert: true });
  const settings = await IntegrationSettings.findOne({ businessId }).select('+mpesa.webhookToken');
 
  const changed = [];
  if (tillNumber !== undefined) { settings.mpesa.tillNumber = tillNumber; changed.push('tillNumber'); }
  if (enabled !== undefined) { settings.mpesa.manualEnabled = enabled; changed.push('manualEnabled'); }
  if (settings.mpesa.manualEnabled && !settings.mpesa.tillNumber) {
    throw ApiError.badRequest('Enter the Till number before enabling manual M-PESA payments', 'MPESA_MANUAL_INCOMPLETE');
  }
  const needsToken = settings.mpesa.manualEnabled && !settings.mpesa.webhookToken;
  if (needsToken || regenerateToken) {
    settings.mpesa.webhookToken = crypto.randomBytes(24).toString('hex');
    changed.push('webhookToken'); // name only, never the value
  }
  settings.mpesa.updatedBy = user._id;
  await settings.save();
 
  await AuditLog.create({
    businessId, userId: user._id, action: 'settings.mpesa.manual.update',
    entityType: 'IntegrationSettings', entityId: settings._id, newValue: { changedFields: changed },
  });
  return getManualSetup(businessId, user);
}

/* ====================================================================== *
 * Status / callback / reconciliation
 * ====================================================================== */

async function getStatus(businessId, reference) {
  const txn = await MpesaTransaction.findOne({ businessId, reference });
  if (!txn) throw ApiError.notFound('M-PESA transaction not found');

  if (txn.channel === 'MANUAL') {
    const resolved = await resolveManual(txn);
    return toClientShape(resolved.txn, { needsCode: resolved.needsCode });
  }

  if (txn.status === 'PENDING') {
    const age = Date.now() - txn.createdAt.getTime();
    const staleEnough = !txn.lastCheckedAt || Date.now() - txn.lastCheckedAt.getTime() > 4000;

    if (staleEnough) {
      try {
        const { credentials } = await loadMpesaConfig(businessId);
        if (!txn.providerReference) throw new Error('No provider reference stored yet');
        const live = await payhero.getTransactionStatus({ credentials, reference: txn.providerReference });
        txn.lastCheckedAt = new Date();
        if (live.status === 'SUCCESS') {
          txn.status = 'SUCCESS';
          await txn.save();
          await backfillReceiptNumber(txn, credentials); // try to get the real code now, since the callback may never arrive
        } else if (live.status === 'FAILED') {
          txn.status = 'FAILED';
          txn.failureType = txn.failureType || 'failed';
          await txn.save();
        } else if (age > PENDING_TIMEOUT_MS) {
          txn.status = 'FAILED';
          txn.failureType = 'timeout';
          txn.resultDesc = 'No response received from customer in time';
          await txn.save();
        } else {
          await txn.save();
        }
      } catch (err) {
        console.error('[mpesa] live status poll failed', { reference: txn.reference, providerReference: txn.providerReference, error: err.message });
        if (age > PENDING_TIMEOUT_MS) {
          txn.status = 'FAILED';
          txn.failureType = 'timeout';
          txn.resultDesc = 'No response received from customer in time';
          await txn.save();
        }
      }
    }
  } else if (txn.status === 'SUCCESS' && !txn.mpesaReceiptNumber) {
    // Already resolved on a previous call but still no code - try again
    // (cheap: this only runs while the frontend keeps polling, which stops
    // once it sees SUCCESS with a message, so in practice this fires once
    // or twice more at most, not indefinitely).
    try {
      const { credentials } = await loadMpesaConfig(businessId);
      await backfillReceiptNumber(txn, credentials);
    } catch {
      // non-fatal - toClientShape below just falls back to the generic message
    }
  }
  return toClientShape(txn);
}

async function handleCallback(businessId, body) {
  const parsed = payhero.parseCallback(body);
  if (!parsed.reference) return;

  const txn = await MpesaTransaction.findOne({ businessId, reference: parsed.reference });
  if (!txn) return;
  // Manual (till) requests are confirmed ONLY through the authenticated till webhook + matching,
  // never through this STK callback.
  if (txn.channel === 'MANUAL') return;

  const interpreted = interpretMpesaResult(parsed.resultCode, parsed.resultDesc);
  const callbackSaysSuccess = interpreted.type === 'success';
  const hadReceiptAlready = !!txn.mpesaReceiptNumber;

  if (txn.status === 'PENDING') {
    txn.status = callbackSaysSuccess ? 'SUCCESS' : 'FAILED';
    txn.failureType = callbackSaysSuccess ? '' : interpreted.type;
  } else if (txn.status === 'FAILED' && callbackSaysSuccess) {
    txn.status = 'SUCCESS';
    txn.failureType = '';
    await notificationService.notifyManagement(businessId, {
      type: 'PAYMENT_FAILED',
      title: 'M-PESA payment succeeded after being marked failed',
      message: `STK push ${txn.reference} (KSh ${(txn.amount / 100).toFixed(2)}) was marked failed/timed out earlier, but M-PESA now confirms it succeeded${parsed.mpesaReceiptNumber ? ` (receipt ${parsed.mpesaReceiptNumber})` : ''}. Please check whether the sale still needs to be completed.`,
      data: { mpesaTransactionId: txn._id },
    });
  }

  if (parsed.mpesaReceiptNumber && looksLikeMpesaReceipt(parsed.mpesaReceiptNumber)) {
    txn.mpesaReceiptNumber = parsed.mpesaReceiptNumber.trim().toUpperCase();
  }
  if (parsed.resultCode !== undefined) txn.resultCode = parsed.resultCode;
  if (parsed.resultDesc) txn.resultDesc = parsed.resultDesc;
  txn.rawCallback = body;
  await txn.save();

  if (parsed.mpesaReceiptNumber && !hadReceiptAlready) {
    await sealInboundForStk(txn);
    await propagateReceiptToPaymentAndReceipt(txn);
  }

  if (txn.status === 'FAILED' && !callbackSaysSuccess) {
    await notificationService.notifyManagement(businessId, {
      type: 'PAYMENT_FAILED',
      title: 'M-PESA payment failed',
      message: `STK push ${txn.reference} for KSh ${(txn.amount / 100).toFixed(2)} failed: ${interpreted.message}`,
      data: { mpesaTransactionId: txn._id, failureType: txn.failureType },
    });
  }
}

async function consumeForSale(businessId, reference, expectedAmountCents, saleId, session) {
  const txn = await MpesaTransaction.findOne({ businessId, reference }).session(session);
  if (!txn) throw ApiError.badRequest('M-PESA reference not recognized', 'MPESA_REFERENCE_NOT_FOUND');
  if (txn.status !== 'SUCCESS') throw ApiError.badRequest('This M-PESA payment has not been confirmed as successful yet', 'MPESA_NOT_CONFIRMED');
  if (txn.saleId) throw ApiError.conflict('This M-PESA payment has already been used on another sale', 'MPESA_ALREADY_CONSUMED');
  if (txn.amount !== expectedAmountCents) throw ApiError.badRequest('The M-PESA amount confirmed does not match this sale', 'MPESA_AMOUNT_MISMATCH');
  txn.saleId = saleId;
  await txn.save({ session });
  return { externalTransactionId: txn.mpesaReceiptNumber, checkoutRequestId: txn.checkoutRequestId, channel: txn.channel || 'STK' };
}

/** Expires stale manual requests and tells management about till payments nobody claimed. */
async function reapManual() {
  await MpesaTransaction.updateMany(
    { channel: 'MANUAL', status: 'PENDING', createdAt: { $lt: new Date(Date.now() - MANUAL_PENDING_TIMEOUT_MS) } },
    { $set: { status: 'FAILED', failureType: 'timeout', resultDesc: 'No payment received in time' } }
  );

  const stale = await MpesaInboundPayment.find({
    status: 'UNCLAIMED', escalatedAt: null, createdAt: { $lt: new Date(Date.now() - INBOUND_ESCALATE_MS) },
  }).limit(100);

  for (const p of stale) {
    const flagged = await MpesaInboundPayment.findOneAndUpdate({ _id: p._id, escalatedAt: null }, { $set: { escalatedAt: new Date() } });
    if (!flagged) continue; // another worker already reported it
    try {
      await notificationService.notifyManagement(p.businessId, {
        type: 'PAYMENT_FAILED',
        title: 'Till payment not matched to a sale',
        message: `M-PESA payment ${p.mpesaReceiptNumber} of KSh ${(p.amount / 100).toFixed(2)}${p.payerName ? ` from ${p.payerName}` : ''} arrived on the Till but was not matched to any POS sale. If a customer paid for a sale that timed out, complete it with this code; otherwise ignore.`,
        data: { mpesaInboundPaymentId: p._id },
      });
    } catch (err) {
      console.error('[mpesa reap] unmatched-payment notification failed', { code: p.mpesaReceiptNumber, error: err.message });
    }
  }
}

async function reapAbandoned() {
  try {
    await reapManual();
  } catch (err) {
    console.error('[mpesa reap] manual sweep failed', err.message);
  }

  const cutoff = new Date(Date.now() - PENDING_TIMEOUT_MS);
  const stale = await MpesaTransaction.find({ status: 'PENDING', channel: { $ne: 'MANUAL' }, createdAt: { $lt: cutoff } }).limit(200);
  for (const txn of stale) {
    const age = Date.now() - txn.createdAt.getTime();
    try {
      const { credentials } = await loadMpesaConfig(txn.businessId);
      if (!txn.providerReference) throw new Error('No provider reference stored yet');
      const live = await payhero.getTransactionStatus({ credentials, reference: txn.providerReference });
      if (live.status === 'SUCCESS') {
        txn.status = 'SUCCESS';
        await txn.save();
        await backfillReceiptNumber(txn, credentials);
        continue;
      }
      if (live.status === 'FAILED') {
        txn.status = 'FAILED';
        txn.failureType = 'failed';
        await txn.save();
        continue;
      }
    } catch (err) {
      console.error('[mpesa reap] status check failed', { reference: txn.reference, error: err.message });
    }

    if (age > HARD_ESCALATE_MS && !txn.escalatedAt) {
      txn.escalatedAt = new Date();
      await txn.save();
      await notificationService.notifyManagement(txn.businessId, {
        type: 'PAYMENT_FAILED',
        title: 'M-PESA payment needs manual check',
        message: `STK push ${txn.reference} (KSh ${(txn.amount / 100).toFixed(2)}) has been unresolved for over 10 minutes. Check PayHero's dashboard directly before assuming it failed - the customer may have already paid.`,
        data: { mpesaTransactionId: txn._id },
      });
    }
  }
  return stale.length;
}

/**
 * backfillMissingReceipts - periodic sweep (see jobs/mpesaReconcile.job.js)
 * catching the case where a transaction resolved SUCCESS but neither the
 * callback nor the point-of-resolution backfill attempt found a receipt
 * code yet (e.g. PayHero's account transactions list hadn't updated the
 * instant we checked). Retries for up to RECEIPT_BACKFILL_MAX_AGE_MS.
 */
async function backfillMissingReceipts() {
  const cutoff = new Date(Date.now() - RECEIPT_BACKFILL_MAX_AGE_MS);
  const pending = await MpesaTransaction.find({
    status: 'SUCCESS',
    channel: { $ne: 'MANUAL' },
    $or: [{ mpesaReceiptNumber: { $exists: false } }, { mpesaReceiptNumber: '' }, { mpesaReceiptNumber: null }],
    createdAt: { $gte: cutoff },
  }).limit(50);

  for (const txn of pending) {
    try {
      const { credentials } = await loadMpesaConfig(txn.businessId);
      await backfillReceiptNumber(txn, credentials);
    } catch (err) {
      console.error('[mpesa backfill sweep] failed', { reference: txn.reference, error: err.message });
    }
  }
  return pending.length;
}

module.exports = {
  initiateStk, getStatus, handleCallback, consumeForSale, reapAbandoned, backfillMissingReceipts,
  initiateManual, cancelManual, claimByCode, ingestInboundPayment, getManualSetup, updateManualSetup,
};