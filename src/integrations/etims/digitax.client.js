const axios = require('axios');
const ApiError = require('../../utils/ApiError');

/**
 * DigiTax base URLs differ between sandbox and production - confirm both
 * against your onboarding pack (they're typically something like
 * https://etims-api-sbx.digitax.co.ke and https://etims-api.digitax.co.ke,
 * but treat the env vars below as the source of truth, not this comment).
 */
const BASE_URLS = {
  sandbox: process.env.DIGITAX_SANDBOX_BASE_URL,
  production: process.env.DIGITAX_PRODUCTION_BASE_URL,
};

function client(environment, credentials) {
  const baseURL = BASE_URLS[environment];
  if (!baseURL) throw ApiError.badRequest(`No DigiTax base URL configured for ${environment}`, 'ETIMS_MISCONFIGURED');
  return axios.create({
    baseURL,
    timeout: 20000,
    headers: {
      'Content-Type': 'application/json',
      // DigiTax auth: adjust to whatever your onboarding pack specifies -
      // some aggregators use a bearer API key, others Basic auth like PayHero.
      Authorization: `Bearer ${credentials.apiKey}`,
      'x-tin': credentials.kraPin,
    },
  });
}

/** Submits one sale as an invoice. Payload shape follows etims.mapper.js - swap the mapper, not this file, if DigiTax's contract differs. */
async function submitInvoice(environment, credentials, payload) {
  try {
    const res = await client(environment, credentials).post('/invoices', payload);
    return res.data;
  } catch (err) {
    throw toEtimsError(err, 'ETIMS_SUBMIT_FAILED');
  }
}

/** Registers/updates a product's item master with KRA via DigiTax - needed before its first sale can be transmitted on some OSCU setups. */
async function registerItem(environment, credentials, payload) {
  try {
    const res = await client(environment, credentials).post('/items', payload);
    return res.data;
  } catch (err) {
    throw toEtimsError(err, 'ETIMS_ITEM_REGISTER_FAILED');
  }
}

async function getInvoiceStatus(environment, credentials, externalReference) {
  try {
    const res = await client(environment, credentials).get(`/invoices/${externalReference}`);
    return res.data;
  } catch (err) {
    throw toEtimsError(err, 'ETIMS_STATUS_CHECK_FAILED');
  }
}

function toEtimsError(err, code) {
  const data = err.response?.data;
  return ApiError.externalService(`DigiTax error: ${data?.message || err.message}`, code);
}

module.exports = { submitInvoice, registerItem, getInvoiceStatus };