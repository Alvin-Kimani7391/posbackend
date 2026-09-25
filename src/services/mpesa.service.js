const crypto = require('crypto');
const MpesaTransaction = require('../models/MpesaTransaction');
const IntegrationSettings = require('../models/IntegrationSettings');
const Payment = require('../models/Payment');
const Receipt = require('../models/Receipt');
const { decryptJson } = require('../utils/crypto');
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

async function loadMpesaConfig(businessId) {
  const settings = await IntegrationSettings.findOne({ businessId }).select('+mpesa.credentialsBlob');
  if (!settings?.mpesa?.enabled) throw ApiError.badRequest('M-PESA is not enabled for this business', 'MPESA_NOT_ENABLED');
  if (!settings.mpesa.credentialsBlob || !settings.mpesa.channelId) {
    throw ApiError.badRequest('M-PESA is enabled but not fully configured. Ask the owner to finish setup.', 'MPESA_NOT_CONFIGURED');
  }
  return { channelId: settings.mpesa.channelId, credentials: decryptJson(settings.mpesa.credentialsBlob) };
}

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
    txn.status = 'FAILED';
    txn.failureType = err.mpesaFailureType || 'send_failed';
    txn.resultDesc = err.message;
    await txn.save();
    throw err;
  }
}

function toClientShape(txn) {
  const successMessage = txn.mpesaReceiptNumber
    ? `Confirmed - M-PESA receipt ${txn.mpesaReceiptNumber}`
    : 'Confirmed - payment received';

  return {
    reference: txn.reference,
    status: txn.status,
    failureType: txn.failureType || null,
    message: txn.status === 'SUCCESS'
      ? successMessage
      : txn.status === 'PENDING'
      ? 'Waiting for the customer to enter their PIN…'
      : (txn.resultDesc && interpretMpesaResult(txn.resultCode, txn.resultDesc).message) || 'Payment was not completed.',
    amount: txn.amount,
    mpesaReceiptNumber: txn.mpesaReceiptNumber || null,
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
      .filter((t) => t.transaction_reference && Number(t.amount) === expectedAmount)
      .map((t) => ({ t, deltaMs: Math.abs(new Date(t.created_at).getTime() - anchorTime) }))
      .filter(({ deltaMs }) => deltaMs < RECEIPT_BACKFILL_WINDOW_MS)
      .sort((a, b) => a.deltaMs - b.deltaMs);

    if (!candidates.length) return;
    const receiptCode = candidates[0].t.transaction_reference;

    // Guard against the (rare) case of two different sales for the same
    // amount within the matching window - never assign a code another
    // MpesaTransaction has already claimed.
    const alreadyUsed = await MpesaTransaction.exists({ mpesaReceiptNumber: receiptCode, _id: { $ne: txn._id } });
    if (alreadyUsed) return;

    txn.mpesaReceiptNumber = receiptCode;
    await txn.save();
    await propagateReceiptToPaymentAndReceipt(txn);
  } catch (err) {
    console.error('[mpesa] receipt backfill failed', { reference: txn.reference, error: err.message });
  }
}

async function getStatus(businessId, reference) {
  const txn = await MpesaTransaction.findOne({ businessId, reference });
  if (!txn) throw ApiError.notFound('M-PESA transaction not found');

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

  if (parsed.mpesaReceiptNumber) txn.mpesaReceiptNumber = parsed.mpesaReceiptNumber;
  if (parsed.resultCode !== undefined) txn.resultCode = parsed.resultCode;
  if (parsed.resultDesc) txn.resultDesc = parsed.resultDesc;
  txn.rawCallback = body;
  await txn.save();

  if (parsed.mpesaReceiptNumber && !hadReceiptAlready) {
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
  return { externalTransactionId: txn.mpesaReceiptNumber, checkoutRequestId: txn.checkoutRequestId };
}

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

module.exports = { initiateStk, getStatus, handleCallback, consumeForSale, reapAbandoned, backfillMissingReceipts };