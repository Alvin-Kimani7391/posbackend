'use strict';
/**
 * Offline M-PESA (till payments only - STK push is NEVER available offline).
 *
 * Flow: customer pays the shop's Till -> cashier reads the M-PESA SMS on the customer's phone ->
 * cashier records the 10-character code + the customer's phone (+ name) on the till, offline ->
 * at sync the server tries to PROVE the payment from the till inbox (MpesaInboundPayment, filled by
 * the PayHero webhook, which reaches the server regardless of the shop's internet) ->
 *   proven    -> VERIFIED_AUTO (payment SUCCESS)
 *   otherwise -> PENDING_REVIEW: a manager/owner approves or rejects (payment PENDING until then).
 * A claim waiting only because the webhook has not arrived yet is re-checked automatically.
 */
const crypto = require('crypto');
const MpesaInboundPayment = require('../models/MpesaInboundPayment');
const MpesaTransaction = require('../models/MpesaTransaction');
const OfflineMpesaClaim = require('../models/OfflineMpesaClaim');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const withTx = require('../utils/withTx');
const { normalizePhone } = require('../utils/phone');
const { ROLES } = require('../constants/roles');
const { getPolicy } = require('../utils/offlinePolicy');
const notificationService = require('./notification.service');
const shortageService = require('./shortage.service');

const ESCALATE_AFTER_MS = 30 * 60 * 1000;
const flag = (code, severity, detail) => ({ code, severity, detail });

/** Re-run CRM capture AFTER a claim becomes verified (bypasses the 60 s de-dupe so the payer phone is not missed). */
function triggerCrm(businessId, saleId) {
  try {
    require('./crm.service').onSaleCompleted(businessId, saleId, 0, true);
  } catch (err) {
    console.error('[offline-mpesa] crm capture failed', err.message);
  }
}

async function safeNotify(businessId, payload) {
  try {
    await notificationService.notifyManagement(businessId, payload);
  } catch (err) {
    console.error('[offline-mpesa] notify failed', err.message);
  }
}

async function createSuccessTxn({ businessId, branchId, cashierId, saleId, code, amountCents, payerPhone, inboundId, session }) {
  const [txn] = await MpesaTransaction.create(
    [{
      businessId, branchId, initiatedBy: cashierId,
      reference: `MPO-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      channel: 'MANUAL', phone: payerPhone || undefined, amount: amountCents,
      status: 'SUCCESS', mpesaReceiptNumber: code, matchedInboundId: inboundId || undefined, saleId,
      resultDesc: 'Offline till payment', lastCheckedAt: new Date(),
    }],
    { session }
  );
  return txn;
}

async function flipInbound(inbound, reference, session) {
  return MpesaInboundPayment.findOneAndUpdate(
    { _id: inbound._id, status: 'UNCLAIMED' },
    { $set: { status: 'CLAIMED', claimedByReference: reference, claimedAt: new Date() } },
    { new: true, session }
  );
}

/**
 * Runs INSIDE the sale-ingest transaction. Decides verified vs pending, writes the claim
 * (and, when verified, the MpesaTransaction), and returns what the Payment document should look like.
 */
async function recordClaimInTx({
  businessId, branchId, saleId, paymentId, cashierId, deviceId, deviceCode, soldAt,
  amountCents, mpesa, approvalMode, maxManualMpesaCents, notAllowed, session,
}) {
  const flags = [];
  const code = mpesa.code;
  const phoneNorm = normalizePhone(mpesa.payerPhone) || undefined;
  if (!phoneNorm) flags.push(flag('MPESA_PHONE_INVALID', 'WARN', `Payer phone "${mpesa.payerPhone}" is not a valid Kenyan number`));

  let reason = null;
  let autoResolvable = false;
  let inbound = null;

  if (notAllowed) {
    reason = 'NOT_ALLOWED';
    flags.push(flag('MPESA_NOT_ALLOWED', 'HIGH', 'Offline M-PESA was not allowed on this device when the sale was made'));
  }
  if (maxManualMpesaCents && amountCents > maxManualMpesaCents) {
    reason = reason || 'OVER_LIMIT';
    flags.push(flag('MPESA_OVER_LIMIT', 'HIGH', `M-PESA amount ${amountCents}c is above the offline limit of ${maxManualMpesaCents}c`));
  }

  const [dupClaim, usedByTxn] = await Promise.all([
    OfflineMpesaClaim.findOne({ businessId, mpesaCode: code, status: { $in: ['VERIFIED_AUTO', 'APPROVED', 'PENDING_REVIEW'] } }).session(session),
    MpesaTransaction.findOne({ businessId, mpesaReceiptNumber: code }).session(session),
  ]);
  if (dupClaim || usedByTxn) {
    reason = reason || 'DUPLICATE_CODE';
    flags.push(flag('MPESA_DUPLICATE_CODE', 'HIGH', `M-PESA code ${code} was already recorded on another sale`));
  }

  if (!reason) {
    inbound = await MpesaInboundPayment.findOne({ businessId, mpesaReceiptNumber: code }).session(session);
    if (!inbound) {
      reason = 'NOT_REPORTED_YET';
      autoResolvable = true;
      flags.push(flag('MPESA_NOT_REPORTED_YET', 'INFO', `Code ${code} has not appeared in the till inbox yet; it will be re-checked automatically`));
    } else if (inbound.status !== 'UNCLAIMED') {
      reason = 'ALREADY_CONSUMED';
      flags.push(flag('MPESA_ALREADY_CONSUMED', 'HIGH', `Code ${code} was already used for another sale`));
    } else if (inbound.amount !== amountCents) {
      reason = 'AMOUNT_MISMATCH';
      flags.push(flag('MPESA_AMOUNT_MISMATCH', 'HIGH', `Customer paid ${inbound.amount}c but the sale recorded ${amountCents}c`));
    } else if (approvalMode === 'ALWAYS') {
      reason = 'APPROVAL_REQUIRED';
      flags.push(flag('MPESA_APPROVAL_REQUIRED', 'INFO', 'Business policy requires a manager to approve every offline M-PESA payment'));
    }
  }

  const base = {
    businessId, branchId, saleId, paymentId, deviceId, deviceCode, cashierId,
    mpesaCode: code, payerPhone: mpesa.payerPhone, payerPhoneNormalized: phoneNorm, payerName: mpesa.payerName,
    amountCents, soldAt, flags,
  };

  // ---- not provable automatically: wait for a human ----
  if (reason) {
    const [claim] = await OfflineMpesaClaim.create(
      [{ ...base, status: 'PENDING_REVIEW', reason, autoResolvable, matchedInboundId: inbound ? inbound._id : undefined }],
      { session }
    );
    return {
      claim, flags, verified: false,
      payment: { status: 'PENDING', completedAt: null, externalTransactionId: undefined, metadata: { offlineClaimId: claim._id, payerPhone: mpesa.payerPhone, payerName: mpesa.payerName, verification: 'PENDING_REVIEW', reason } },
    };
  }

  // ---- proven: take the payment from the inbox atomically ----
  const flipped = await flipInbound(inbound, `OFF-${paymentId}`, session);
  if (!flipped) {
    flags.push(flag('MPESA_CLAIM_RACE', 'HIGH', `Code ${code} was taken by another sale a moment ago`));
    const [claim] = await OfflineMpesaClaim.create([{ ...base, status: 'PENDING_REVIEW', reason: 'CLAIM_RACE' }], { session });
    return {
      claim, flags, verified: false,
      payment: { status: 'PENDING', completedAt: null, metadata: { offlineClaimId: claim._id, payerPhone: mpesa.payerPhone, verification: 'PENDING_REVIEW', reason: 'CLAIM_RACE' } },
    };
  }

  if (phoneNorm && inbound.payerPhone) {
    const inboundNorm = normalizePhone(inbound.payerPhone);
    if (inboundNorm && inboundNorm !== phoneNorm) {
      flags.push(flag('MPESA_PHONE_DIFFERS', 'WARN', 'Payer phone given by the cashier differs from the phone on the M-PESA record'));
    }
  }

  const txn = await createSuccessTxn({ businessId, branchId, cashierId, saleId, code, amountCents, payerPhone: mpesa.payerPhone, inboundId: inbound._id, session });
  const [claim] = await OfflineMpesaClaim.create(
    [{ ...base, status: 'VERIFIED_AUTO', activeCode: code, matchedInboundId: inbound._id, mpesaTransactionId: txn._id, verifiedAt: new Date() }],
    { session }
  );
  return {
    claim, flags, verified: true,
    payment: { status: 'SUCCESS', completedAt: soldAt, externalTransactionId: code, metadata: { offlineClaimId: claim._id, payerPhone: mpesa.payerPhone, payerName: mpesa.payerName, verification: 'AUTO', checkoutRequestId: undefined } },
  };
}

/* ------------------------- automatic re-check ------------------------- */

/** Re-checks ONE waiting claim against the till inbox. Returns true if it became VERIFIED_AUTO. */
async function autoVerifyClaim(claimId) {
  const done = await withTx(async (session) => {
    const claim = await OfflineMpesaClaim.findOne({ _id: claimId, status: 'PENDING_REVIEW', autoResolvable: true }).session(session);
    if (!claim) return false;

    const business = await Business.findById(claim.businessId).select('settings').session(session);
    if (getPolicy(business).manualMpesaApproval === 'ALWAYS') return false;

    const [dup, usedByTxn] = await Promise.all([
      OfflineMpesaClaim.findOne({ businessId: claim.businessId, mpesaCode: claim.mpesaCode, _id: { $ne: claim._id }, status: { $in: ['VERIFIED_AUTO', 'APPROVED'] } }).session(session),
      MpesaTransaction.findOne({ businessId: claim.businessId, mpesaReceiptNumber: claim.mpesaCode }).session(session),
    ]);
    if (dup || usedByTxn) return false;

    const inbound = await MpesaInboundPayment.findOneAndUpdate(
      { businessId: claim.businessId, mpesaReceiptNumber: claim.mpesaCode, status: 'UNCLAIMED', amount: claim.amountCents },
      { $set: { status: 'CLAIMED', claimedByReference: `OFF-${claim.paymentId}`, claimedAt: new Date() } },
      { new: true, session }
    );
    if (!inbound) return false;

    const txn = await createSuccessTxn({
      businessId: claim.businessId, branchId: claim.branchId, cashierId: claim.cashierId, saleId: claim.saleId,
      code: claim.mpesaCode, amountCents: claim.amountCents, payerPhone: claim.payerPhone, inboundId: inbound._id, session,
    });

    claim.status = 'VERIFIED_AUTO';
    claim.activeCode = claim.mpesaCode;
    claim.matchedInboundId = inbound._id;
    claim.mpesaTransactionId = txn._id;
    claim.verifiedAt = new Date();
    claim.autoResolvable = false;
    await claim.save({ session });

    await Payment.updateOne(
      { _id: claim.paymentId },
      { $set: { status: 'SUCCESS', completedAt: claim.soldAt, externalTransactionId: claim.mpesaCode, 'metadata.verification': 'AUTO' } },
      { session }
    );
    await AuditLog.create(
      [{ businessId: claim.businessId, branchId: claim.branchId, userId: claim.cashierId, action: 'offline.mpesa.auto_verify', entityType: 'OfflineMpesaClaim', entityId: claim._id, newValue: { code: claim.mpesaCode, amountCents: claim.amountCents } }],
      { session }
    );
    return { businessId: claim.businessId, saleId: claim.saleId };
  });
  if (!done) return false;
  triggerCrm(done.businessId, done.saleId);
  return true;
}

/** Called right after a till payment lands in the inbox (see mpesa.service.ingestInboundPayment). */
async function resolveForInbound(inbound) {
  const waiting = await OfflineMpesaClaim.find({
    businessId: inbound.businessId, mpesaCode: inbound.mpesaReceiptNumber,
    status: 'PENDING_REVIEW', autoResolvable: true, amountCents: inbound.amount,
  }).limit(2);
  if (waiting.length !== 1) return false; // none, or ambiguous -> a human decides
  return autoVerifyClaim(waiting[0]._id);
}

/** Cron sweep: re-check waiting claims, then tell management about claims nobody has looked at. */
async function sweep() {
  const waiting = await OfflineMpesaClaim.find({ status: 'PENDING_REVIEW', autoResolvable: true }).sort({ createdAt: 1 }).limit(200);
  for (const c of waiting) {
    try { await autoVerifyClaim(c._id); } catch (err) { console.error('[offline-mpesa sweep] verify failed', err.message); }
  }

  const stale = await OfflineMpesaClaim.find({
    status: 'PENDING_REVIEW', escalatedAt: null, createdAt: { $lt: new Date(Date.now() - ESCALATE_AFTER_MS) },
  }).limit(100);
  for (const c of stale) {
    const taken = await OfflineMpesaClaim.findOneAndUpdate({ _id: c._id, escalatedAt: null }, { $set: { escalatedAt: new Date() } });
    if (!taken) continue;
    await safeNotify(c.businessId, {
      type: 'PAYMENT_FAILED',
      title: 'Offline M-PESA payment needs approval',
      message: `M-PESA code ${c.mpesaCode} (KSh ${(c.amountCents / 100).toFixed(2)}) recorded offline is waiting for a manager's approval.`,
      data: { offlineMpesaClaimId: c._id, saleId: c.saleId },
    });
  }
}

/* ------------------------- manager / owner decisions ------------------------- */

function assertNotSelf(claim, user) {
  if (String(claim.cashierId) === String(user._id) && user.role !== ROLES.OWNER) {
    throw ApiError.forbidden('You cannot approve or reject a payment you recorded yourself', 'SELF_REVIEW_NOT_ALLOWED');
  }
}

async function approveClaim(businessId, user, claimId, note) {
  const claim = await withTx(async (session) => {
    const c = await OfflineMpesaClaim.findOne({ _id: claimId, businessId }).session(session);
    if (!c) throw ApiError.notFound('Claim not found');
    if (c.status !== 'PENDING_REVIEW') throw ApiError.conflict('This claim has already been decided', 'CLAIM_NOT_PENDING');
    assertNotSelf(c, user);

    const dup = await OfflineMpesaClaim.findOne({
      businessId, mpesaCode: c.mpesaCode, _id: { $ne: c._id }, status: { $in: ['VERIFIED_AUTO', 'APPROVED'] },
    }).session(session);
    if (dup) throw ApiError.conflict('That M-PESA code has already been accepted on another sale', 'MPESA_ALREADY_CONSUMED');

    const inbound = await MpesaInboundPayment.findOne({ businessId, mpesaReceiptNumber: c.mpesaCode }).session(session);
    let inboundId = null;
    if (inbound && inbound.status === 'UNCLAIMED') {
      const flipped = await flipInbound(inbound, `OFF-${c.paymentId}`, session);
      if (!flipped) throw ApiError.conflict('That payment was just used elsewhere. Refresh and check again.', 'MPESA_CLAIM_RACE');
      inboundId = inbound._id;
    } else if (inbound && inbound.status === 'CLAIMED') {
      // The till payment is already attached to something else. Only the owner may override that.
      if (user.role !== ROLES.OWNER) throw ApiError.forbidden('This M-PESA code is already attached to another payment. Only the owner can override.', 'OWNER_REQUIRED');
      inboundId = inbound._id;
    }

    const txn = await createSuccessTxn({
      businessId, branchId: c.branchId, cashierId: c.cashierId, saleId: c.saleId,
      code: c.mpesaCode, amountCents: c.amountCents, payerPhone: c.payerPhone, inboundId, session,
    });

    c.status = 'APPROVED';
    c.activeCode = c.mpesaCode;
    c.autoResolvable = false;
    c.mpesaTransactionId = txn._id;
    if (inboundId) c.matchedInboundId = inboundId;
    c.reviewedBy = user._id;
    c.reviewedAt = new Date();
    c.reviewNote = note;
    await c.save({ session });

    await Payment.updateOne(
      { _id: c.paymentId },
      { $set: { status: 'SUCCESS', completedAt: c.soldAt, externalTransactionId: c.mpesaCode, 'metadata.verification': 'APPROVED', 'metadata.approvedBy': String(user._id) } },
      { session }
    );
    await AuditLog.create(
      [{ businessId, branchId: c.branchId, userId: user._id, action: 'offline.mpesa.approve', entityType: 'OfflineMpesaClaim', entityId: c._id, newValue: { code: c.mpesaCode, amountCents: c.amountCents, reason: c.reason, note } }],
      { session }
    );
    return c;
  });
  triggerCrm(businessId, claim.saleId);
  return claim;
}

async function rejectClaim(businessId, user, claimId, note, chargeCashier = false) {
  let shortage = null;
  const claim = await withTx(async (session) => {
    const c = await OfflineMpesaClaim.findOne({ _id: claimId, businessId }).session(session);
    if (!c) throw ApiError.notFound('Claim not found');
    if (c.status !== 'PENDING_REVIEW') throw ApiError.conflict('This claim has already been decided', 'CLAIM_NOT_PENDING');
    assertNotSelf(c, user);

    c.status = 'REJECTED';
    c.autoResolvable = false;
    c.reviewedBy = user._id;
    c.reviewedAt = new Date();
    c.reviewNote = note;
    await c.save({ session });

    await Payment.updateOne({ _id: c.paymentId }, { $set: { status: 'FAILED', 'metadata.verification': 'REJECTED', 'metadata.rejectedBy': String(user._id) } }, { session });

    // The money was never received: the sale shows the amount as unpaid again so reports and the owner see the loss.
    const sale = await Sale.findOne({ _id: c.saleId, businessId }).session(session);
    if (sale) {
      sale.amountPaid = Math.max(sale.amountPaid - c.amountCents, 0);
      sale.balance = sale.balance + c.amountCents;
      sale.paymentStatus = sale.amountPaid <= 0 ? 'UNPAID' : 'PARTIAL';
      sale.reviewFlags.push({ code: 'MPESA_REJECTED', severity: 'HIGH', detail: `M-PESA ${c.mpesaCode} (${c.amountCents}c) was rejected: ${note}` });
      sale.reviewStatus = 'PENDING';
      await sale.save({ session });
    }
    // The manager decided the cashier must cover the loss: it becomes a trackable debt (repaid through the normal shortage screens).
    if (chargeCashier) shortage = await shortageService.recordMpesaLoss({ claim: c, actor: user, session });

    await AuditLog.create(
      [{ businessId, branchId: c.branchId, userId: user._id, action: 'offline.mpesa.reject', entityType: 'OfflineMpesaClaim', entityId: c._id, newValue: { code: c.mpesaCode, amountCents: c.amountCents, note } }],
      { session }
    );
    return c;
  });

  await safeNotify(businessId, {
    type: 'PAYMENT_FAILED',
    title: 'Offline M-PESA payment rejected',
    message: `M-PESA ${claim.mpesaCode} (KSh ${(claim.amountCents / 100).toFixed(2)}) was rejected. The sale now shows that amount as unpaid.`,
    data: { offlineMpesaClaimId: claim._id, saleId: claim.saleId },
  });
  if (shortage) {
    try {
      await notificationService.notifyUser(businessId, claim.cashierId, {
        type: 'CASH_SHORTAGE',
        title: 'M-PESA payment rejected - recorded against you',
        message: `The M-PESA payment ${claim.mpesaCode} (KSh ${(claim.amountCents / 100).toFixed(2)}) you recorded was rejected and has been recorded as a shortage against you. Speak to your manager.`,
        entityType: 'CashierShortage', entityId: shortage._id, branchId: claim.branchId,
        data: { shortageId: shortage._id, amount: claim.amountCents, balance: claim.amountCents, mpesaCode: claim.mpesaCode },
      });
    } catch (err) {
      console.error('[offline-mpesa] cashier notify failed', err.message);
    }
  }
  return claim;
}

async function listClaims(businessId, { status, branchId, page = 1, limit = 20 }) {
  const filter = { businessId };
  filter.status = status || 'PENDING_REVIEW';
  if (branchId) filter.branchId = branchId;
  const [items, total] = await Promise.all([
    OfflineMpesaClaim.find(filter)
      .populate('saleId', 'receiptNumber total soldAt')
      .populate('cashierId', 'name')
      .populate('reviewedBy', 'name')
      .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    OfflineMpesaClaim.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

module.exports = {
  recordClaimInTx, autoVerifyClaim, resolveForInbound, sweep,
  approveClaim, rejectClaim, listClaims,
};