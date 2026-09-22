const mongoose = require('mongoose');
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

async function loadEtimsConfig(businessId) {
  const settings = await IntegrationSettings.findOne({ businessId }).select('+etims.credentialsBlob');
  if (!settings?.etims?.enabled) return null; // simply not enabled - not an error, callers just skip
  if (!settings.etims.credentialsBlob) return null;
  return {
    environment: settings.etims.environment,
    credentials: { ...decryptJson(settings.etims.credentialsBlob), kraPin: settings.etims.kraPin },
  };
}

/** Called from sale.service right after a sale commits. Creates a PENDING EtimsTransaction and fires it - if eTIMS isn't enabled, this is a silent no-op. */
async function enqueueForSale(businessId, branchId, saleId, { session } = {}) {
  const config = await loadEtimsConfig(businessId);
  if (!config) return null;

  const sale = await Sale.findById(saleId).session(session || null);
  const [etx] = await EtimsTransaction.create(
    [{ businessId, branchId, saleId, invoiceNumber: sale.invoiceNumber || sale.receiptNumber, status: 'PENDING' }],
    session ? { session } : {}
  );

  // Fire-and-forget: don't let a slow KRA/DigiTax response hold the HTTP
  // response to the cashier hostage. Failures land in EtimsTransaction and
  // get picked up by the retry job (see jobs/etimsRetry.job.js).
  setImmediate(() => submit(businessId, etx._id).catch(() => {}));
  return etx;
}

async function submit(businessId, etimsTransactionId) {
  const etx = await EtimsTransaction.findOne({ _id: etimsTransactionId, businessId });
  if (!etx || etx.status === 'COMPLETED') return etx;

  const config = await loadEtimsConfig(businessId);
  if (!config) return etx; // got disabled mid-flight - leave PENDING, don't error

  const [sale, business] = await Promise.all([Sale.findById(etx.saleId), Business.findById(businessId)]);
  const branch = await Branch.findById(etx.branchId);
  const payload = saleToDigiTaxInvoice({ sale, business, branch });
  etx.requestPayload = payload;

  try {
    const response = await digitax.submitInvoice(config.environment, config.credentials, payload);
    etx.responsePayload = response;
    etx.externalReference = response.sale_id || response.invoiceNumber || response.id;
    etx.status = response.status === 'COMPLETED' || response.success ? 'COMPLETED' : 'SUBMITTED';
    etx.confirmedAt = etx.status === 'COMPLETED' ? new Date() : undefined;
    await etx.save();

    if (etx.status === 'COMPLETED') {
      await Receipt.updateOne(
        { saleId: sale._id },
        { $set: { 'receiptData.etims': { reference: etx.externalReference, url: response.etims_url, signature: response.signature, submittedAt: new Date() } } }
      );
    }
  } catch (err) {
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
  return etx;
}

/** Manual retry, e.g. an owner clicking "Retry" in the eTIMS screen. Requires etims.submit permission at the route level. */
async function retry(businessId, id) {
  const etx = await EtimsTransaction.findOne({ _id: id, businessId });
  if (!etx) throw ApiError.notFound('eTIMS transaction not found');
  if (etx.status === 'COMPLETED') throw ApiError.conflict('Already completed', 'ETIMS_ALREADY_COMPLETED');
  return submit(businessId, etx._id);
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

/** Used by the retry cron - every business's queue in one pass. */
async function retryAllDue() {
  const due = await EtimsTransaction.find({ status: 'FAILED', retryCount: { $lt: MAX_RETRIES } }).limit(100);
  for (const etx of due) {
    await submit(etx.businessId, etx._id).catch(() => {});
  }
}

module.exports = { enqueueForSale, submit, retry, listForBusiness, retryAllDue };