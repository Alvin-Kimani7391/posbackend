const EtimsTransaction = require('../models/EtimsTransaction');
const IntegrationSettings = require('../models/IntegrationSettings');
const Sale = require('../models/Sale');
const Business = require('../models/Business');
const Branch = require('../models/Branch');
const Receipt = require('../models/Receipt');
const { decryptJson } = require('../utils/crypto');
const { saleToDigiTaxInvoice } = require('../integrations/etims/etims.mapper');
const digitax = require('../integrations/etims/digitax.client');
const notificationService = require('./notification.service');
const ApiError = require('../utils/ApiError');

const MAX_RETRIES = 5;
const CLAIM_LOCK_MS = 2 * 60 * 1000;     // a worker owns an invoice for at most this long
const ORPHAN_AFTER_MS = 60 * 1000;       // PENDING this long with no attempt = never kicked (crash, restart) -> sweep it
const FAILED_BACKOFF_MS = 2 * 60 * 1000; // minimum gap between automatic retries of a FAILED invoice

async function loadEtimsConfig(businessId) {
  const settings = await IntegrationSettings.findOne({ businessId }).select('+etims.credentialsBlob');
  if (!settings?.etims?.enabled) return null; // simply not enabled - not an error, callers just skip
  if (!settings.etims.credentialsBlob) return null;
  return {
    environment: settings.etims.environment,
    credentials: { ...decryptJson(settings.etims.credentialsBlob), kraPin: settings.etims.kraPin },
  };
}

/**
 * Called from sale.service INSIDE the sale transaction. It only records the PENDING EtimsTransaction.
 * It deliberately does NOT submit: submitting here could run before the transaction commits (the
 * other connection would not see the sale or the row yet). The submit is started by kickForSale()
 * AFTER commit, and retryAllDue() sweeps anything that was missed.
 */
async function enqueueForSale(businessId, branchId, saleId, { session } = {}) {
  const config = await loadEtimsConfig(businessId);
  if (!config) return null;

  const sale = await Sale.findById(saleId).session(session || null);
  const [etx] = await EtimsTransaction.create(
    [{ businessId, branchId, saleId, invoiceNumber: sale.invoiceNumber || sale.receiptNumber, status: 'PENDING' }],
    session ? { session } : {}
  );
  return etx;
}

/** Call AFTER the sale transaction has committed. Fire-and-forget; never throws, never blocks checkout. */
function kickForSale(businessId, saleId) {
  setImmediate(async () => {
    try {
      const etx = await EtimsTransaction.findOne({ businessId, saleId }).select('_id');
      if (etx) await submit(businessId, etx._id);
    } catch (err) {
      console.error('[etims] post-commit kick failed', err.message);
    }
  });
}

async function markFailed(etx, businessId, err) {
  etx.status = 'FAILED';
  etx.errorMessage = err.message;
  etx.retryCount += 1;
  await etx.save();

  if (etx.retryCount >= MAX_RETRIES) {
    await notificationService.notifyManagement(businessId, {
      type: 'ETIMS_FAILED',
      title: 'eTIMS submission failing repeatedly',
      message: `Sale ${etx.invoiceNumber} has failed eTIMS submission ${etx.retryCount} times: ${err.message}`,
      data: { etimsTransactionId: etx._id, saleId: etx.saleId },
    });
  }
}

/**
 * Submits one invoice. An atomic claim (lockedUntil) guarantees only ONE worker can submit a given
 * invoice at a time, so the post-commit kick and the cron can never create duplicate fiscal invoices.
 * Returns null if the invoice is completed/submitted or another worker currently owns it.
 */
async function submit(businessId, etimsTransactionId) {
  const now = new Date();
  const etx = await EtimsTransaction.findOneAndUpdate(
    {
      _id: etimsTransactionId,
      businessId,
      status: { $in: ['PENDING', 'FAILED'] },
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    { $set: { lockedUntil: new Date(now.getTime() + CLAIM_LOCK_MS) } },
    { new: true }
  );
  if (!etx) return null;

  try {
    const config = await loadEtimsConfig(businessId);
    if (!config) {
      etx.errorMessage = 'eTIMS is not enabled or not configured for this business';
      await etx.save(); // bumps updatedAt so this row rotates to the back of the sweep queue
      return etx;
    }

    const [sale, business, branch] = await Promise.all([
      Sale.findById(etx.saleId),
      Business.findById(businessId),
      Branch.findById(etx.branchId),
    ]);
    const payload = saleToDigiTaxInvoice({ sale, business, branch });
    etx.requestPayload = payload;

    let response;
    try {
      response = await digitax.submitInvoice(config.environment, config.credentials, payload);
    } catch (err) {
      await markFailed(etx, businessId, err);
      return etx;
    }

    etx.responsePayload = response;
    etx.externalReference = response.sale_id || response.invoiceNumber || response.id;
    etx.status = response.status === 'COMPLETED' || response.success ? 'COMPLETED' : 'SUBMITTED';
    etx.confirmedAt = etx.status === 'COMPLETED' ? new Date() : undefined;
    etx.errorMessage = undefined;
    await etx.save();

    if (etx.status === 'COMPLETED') {
      await Receipt.updateOne(
        { saleId: sale._id },
        { $set: { 'receiptData.etims': { reference: etx.externalReference, url: response.etims_url, signature: response.signature, submittedAt: new Date() } } }
      );
    }
    return etx;
  } finally {
    await EtimsTransaction.updateOne({ _id: etx._id }, { $unset: { lockedUntil: 1 } }).catch(() => {});
  }
}

/** Manual retry, e.g. an owner clicking "Retry" in the eTIMS screen. Requires etims.submit permission at the route level. */
async function retry(businessId, id) {
  const etx = await EtimsTransaction.findOne({ _id: id, businessId });
  if (!etx) throw ApiError.notFound('eTIMS transaction not found');
  if (etx.status === 'COMPLETED') throw ApiError.conflict('Already completed', 'ETIMS_ALREADY_COMPLETED');
  if (etx.status === 'SUBMITTED') throw ApiError.conflict('Already submitted and awaiting KRA confirmation', 'ETIMS_AWAITING_CONFIRMATION');
  const result = await submit(businessId, etx._id);
  return result || EtimsTransaction.findOne({ _id: id, businessId }); // another worker has it right now
}

async function listForBusiness(businessId, { status, page, limit }) {
  const filter = { businessId };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([
    EtimsTransaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    EtimsTransaction.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * Used by the retry cron - every business's queue in one pass.
 * Picks up FAILED invoices (with backoff) AND orphaned PENDING ones that were never submitted.
 * Oldest-touched first, so rows that cannot progress rotate instead of hogging the batch.
 */
async function retryAllDue() {
  const now = Date.now();
  const due = await EtimsTransaction.find({
    $or: [
      { status: 'FAILED', retryCount: { $lt: MAX_RETRIES }, updatedAt: { $lt: new Date(now - FAILED_BACKOFF_MS) } },
      { status: 'PENDING', updatedAt: { $lt: new Date(now - ORPHAN_AFTER_MS) } },
    ],
  }).sort({ updatedAt: 1 }).limit(100);

  for (const etx of due) {
    await submit(etx.businessId, etx._id).catch((err) => console.error('[etims retry]', err.message));
  }
}

module.exports = { enqueueForSale, kickForSale, submit, retry, listForBusiness, retryAllDue };