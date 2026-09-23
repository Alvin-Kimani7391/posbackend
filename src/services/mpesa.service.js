const crypto = require('crypto');
const MpesaTransaction = require('../models/MpesaTransaction');
const IntegrationSettings = require('../models/IntegrationSettings');
const { decryptJson } = require('../utils/crypto');
const payhero = require('../integrations/mpesa/payhero.provider');
const { interpretMpesaResult } = require('../utils/mpesaErrors');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

const COOLDOWN_AFTER_FAILURES = 3;        // consecutive failed attempts...
const COOLDOWN_WINDOW_MS = 2 * 60 * 1000; // ...within this window trigger a short cooldown
const COOLDOWN_DURATION_MS = 60 * 1000;
const PENDING_TIMEOUT_MS = 90 * 1000;     // Safaricom's own STK prompt expires around this mark
const HARD_ESCALATE_MS = 10 * 60 * 1000;  // 10 minutes fully unresolved -> stop retrying automatically, tell a human

async function loadMpesaConfig(businessId) {
  const settings = await IntegrationSettings.findOne({ businessId }).select('+mpesa.credentialsBlob');
  if (!settings?.mpesa?.enabled) throw ApiError.badRequest('M-PESA is not enabled for this business', 'MPESA_NOT_ENABLED');
  if (!settings.mpesa.credentialsBlob || !settings.mpesa.channelId) {
    throw ApiError.badRequest('M-PESA is enabled but not fully configured. Ask the owner to finish setup.', 'MPESA_NOT_CONFIGURED');
  }
  return { channelId: settings.mpesa.channelId, credentials: decryptJson(settings.mpesa.credentialsBlob) };
}

/** Defensive anti-abuse guard on OUR side too - PayHero itself locks an account out after enough failures, and we'd rather show a clear "wait a moment" message than let the cashier hammer a dead integration into that lockout. */
async function assertNotCoolingDown(businessId, branchId) {
  const recent = await MpesaTransaction.find({
    businessId, branchId, createdAt: { $gte: new Date(Date.now() - COOLDOWN_WINDOW_MS) },
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
    // The push itself never reached the customer's phone - fail fast and
    // tell the cashier exactly why (bad credentials / rate limit / network),
    // distinct from a Safaricom-side result that arrives later via callback.
    txn.status = 'FAILED';
    txn.failureType = err.mpesaFailureType || 'send_failed';
    txn.resultDesc = err.message;
    await txn.save();
    throw err; // controller surfaces err.message + err.mpesaFailureType to the cashier immediately
  }
}

function toClientShape(txn) {
  return {
    reference: txn.reference,
    status: txn.status, // PENDING | SUCCESS | FAILED | CANCELLED
    failureType: txn.failureType || null,
    message: txn.status === 'SUCCESS'
      ? `Confirmed - M-PESA receipt ${txn.mpesaReceiptNumber}`
      : txn.status === 'PENDING'
      ? 'Waiting for the customer to enter their PIN…'
      : (txn.resultDesc && interpretMpesaResult(txn.resultCode, txn.resultDesc).message) || 'Payment was not completed.',
    amount: txn.amount,
    mpesaReceiptNumber: txn.mpesaReceiptNumber || null,
  };
}

async function getStatus(businessId, reference) {
  const txn = await MpesaTransaction.findOne({ businessId, reference });
  if (!txn) throw ApiError.notFound('M-PESA transaction not found');

  if (txn.status === 'PENDING') {
    // Client-visible timeout: Safaricom's own prompt window has almost
    // certainly closed by now. Mark it so the cashier gets a clear "timeout"
    // state instead of an endless spinner, while a live poll (below) still
    // gets one last chance to catch a delayed-but-genuine success.
    const age = Date.now() - txn.createdAt.getTime();
    const staleEnough = !txn.lastCheckedAt || Date.now() - txn.lastCheckedAt.getTime() > 4000;

    if (staleEnough) {
      try {
        const { credentials } = await loadMpesaConfig(businessId);
        // PayHero's status endpoint takes THEIR reference (txn.providerReference,
        // returned in the initiate response), never our internal txn.reference.
        if (!txn.providerReference) throw new Error('No provider reference stored yet');
        const live = await payhero.getTransactionStatus({ credentials, reference: txn.providerReference });
        txn.lastCheckedAt = new Date();
        if (live.status === 'SUCCESS') {
          txn.status = 'SUCCESS';
        } else if (live.status === 'FAILED') {
          txn.status = 'FAILED';
          txn.failureType = txn.failureType || 'failed';
        } else if (age > PENDING_TIMEOUT_MS) {
          txn.status = 'FAILED';
          txn.failureType = 'timeout';
          txn.resultDesc = 'No response received from customer in time';
        }
        await txn.save();
      } catch (err) {
        console.error('[mpesa] live status poll failed', { reference: txn.reference, providerReference: txn.providerReference, error: err.message });
        // Live poll hiccuped - if we're already past the timeout window,
        // still resolve to timeout locally rather than spinning forever.
        if (age > PENDING_TIMEOUT_MS) {
          txn.status = 'FAILED';
          txn.failureType = 'timeout';
          txn.resultDesc = 'No response received from customer in time';
          await txn.save();
        }
      }
    }
  }
  return toClientShape(txn);
}

async function handleCallback(businessId, body) {
  const parsed = payhero.parseCallback(body);
  if (!parsed.reference) return;

  const txn = await MpesaTransaction.findOne({ businessId, reference: parsed.reference });
  if (!txn || txn.status !== 'PENDING') return; // unknown or already-terminal - idempotent no-op

  const interpreted = interpretMpesaResult(parsed.resultCode, parsed.resultDesc);

  txn.status = interpreted.type === 'success' ? 'SUCCESS' : 'FAILED';
  txn.failureType = interpreted.type === 'success' ? '' : interpreted.type;
  txn.mpesaReceiptNumber = parsed.mpesaReceiptNumber;
  txn.resultCode = parsed.resultCode;
  txn.resultDesc = parsed.resultDesc;
  txn.rawCallback = body;
  await txn.save();

  if (txn.status === 'FAILED') {
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
  return { externalTransactionId: txn.mpesaReceiptNumber, checkoutRequestId: txn.checkoutRequestId };
}

/** Sweep for the reconciliation job - PENDING transactions whose window has clearly closed but whose browser tab may have been closed before getStatus() could resolve them locally. Mirrors the previous site's paymentReaper, minus stock restoration (nothing is reserved here until a Sale actually exists).
 * Never auto-fails a transaction the system genuinely can't resolve: if PayHero
 * itself reports QUEUED (or the status check errors) past the pending timeout,
 * the transaction is left PENDING and, once it's been unresolved for
 * HARD_ESCALATE_MS, management is notified to check PayHero's dashboard
 * directly rather than risk marking an actually-paid transaction FAILED. */
async function reapAbandoned() {
  const cutoff = new Date(Date.now() - PENDING_TIMEOUT_MS);
  const stale = await MpesaTransaction.find({ status: 'PENDING', createdAt: { $lt: cutoff } }).limit(200);
  for (const txn of stale) {
    const age = Date.now() - txn.createdAt.getTime();
    try {
      const { credentials } = await loadMpesaConfig(txn.businessId);
      if (!txn.providerReference) throw new Error('No provider reference stored yet');
      const live = await payhero.getTransactionStatus({ credentials, reference: txn.providerReference });
      if (live.status === 'SUCCESS') {
        txn.status = 'SUCCESS';
        await txn.save();
        continue;
      }
      if (live.status === 'FAILED') {
        txn.status = 'FAILED';
        txn.failureType = 'failed';
        await txn.save();
        continue;
      }
      // still QUEUED per PayHero itself - genuinely still pending, not our bug.
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

module.exports = { initiateStk, getStatus, handleCallback, consumeForSale, reapAbandoned };