const { Schema, model } = require('mongoose');

/**
 * Tracks one M-PESA payment attempt end-to-end.
 *
 *   channel 'STK'    - PayHero STK push (cashier types the phone, customer gets a prompt).
 *                      This is the original flow and the default, so every document that
 *                      already exists in your database keeps behaving exactly as before.
 *   channel 'MANUAL' - Buy Goods / Till payment. The customer pays the Till themselves and
 *                      PayHero notifies us; the payment is matched here (see
 *                      mpesa.service.tryAutoMatch / claimByCode) against a MpesaInboundPayment.
 *
 * A Sale/Payment is only ever created from a MpesaTransaction that has reached SUCCESS AND
 * whose saleId is still null (see mpesa.service.consumeForSale) - this is what stops a cashier
 * (or a compromised client) from typing in a fake MPESA reference and having it accepted,
 * the way CASH/CARD/BANK still can be.
 */
const mpesaTransactionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    // Documents created before this field existed have no value stored; Mongoose applies the
    // default on read, but a raw DB query must treat "missing" as STK (use { $ne: 'MANUAL' }).
    channel: { type: String, enum: ['STK', 'MANUAL'], default: 'STK' },

    reference: { type: String, required: true }, // our external_reference, e.g. "MPX-xxxx" (STK) or "MPM-xxxx" (MANUAL)
    // STK needs the customer's phone up-front; a MANUAL payment has no phone until it is matched.
    phone: { type: String, required: function requiredPhone() { return this.channel !== 'MANUAL'; } },
    amount: { type: Number, required: true }, // integer cents

    tillNumber: { type: String }, // MANUAL only: the Buy Goods till the customer was asked to pay
    matchedInboundId: { type: Schema.Types.ObjectId, ref: 'MpesaInboundPayment' }, // MANUAL only: the till payment this request was matched to

    provider: { type: String, default: 'payhero' },
    checkoutRequestId: { type: String },
    providerReference: { type: String }, // PayHero's own "reference" from the initiate response - required for GET /transaction-status, NOT our internal `reference`

    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'], default: 'PENDING', index: true },
    mpesaReceiptNumber: { type: String }, // STK: only ever arrives via PayHero's callback/backfill. MANUAL: always set at match time.
    resultCode: { type: String },
    resultDesc: { type: String },
    failureType: { type: String, default: '' }, // 'wrong_pin' | 'insufficient_funds' | 'cancelled' | 'timeout' | 'in_progress' | 'system_error' | 'bad_credentials' | 'rate_limited' | 'send_failed' | 'failed' | ''

    rawInitiateResponse: { type: Schema.Types.Mixed },
    rawCallback: { type: Schema.Types.Mixed },

    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', default: null }, // set once consumed by a completed sale
    lastCheckedAt: { type: Date },
    escalatedAt: { type: Date }, // set once a genuinely-unresolved PENDING transaction has been flagged to management (see reapAbandoned)
  },
  { timestamps: true }
);

mpesaTransactionSchema.index({ businessId: 1, reference: 1 }, { unique: true });
mpesaTransactionSchema.index({ status: 1, createdAt: 1 }); // for the reconciliation job
mpesaTransactionSchema.index({ businessId: 1, channel: 1, status: 1, amount: 1 }); // manual matching lookups
mpesaTransactionSchema.index({ businessId: 1, mpesaReceiptNumber: 1 }, { sparse: true }); // "is this receipt code already used?" checks

/* ------------------------------------------------------------------ *
 * CRM capture hook.
 * The moment a successful M-PESA payment is attached to a sale (saleId newly set by
 * mpesa.service.consumeForSale), ask the CRM to link the sale to the customer by phone.
 *  - pre('save') only records whether saleId was just set, so later saves of the same
 *    document (receipt backfill, status polling) never re-trigger it.
 *  - The short delay lets the sale's DB transaction commit first; crm.service retries on its
 *    own and crmSync.job is the safety net, so a miss here is never fatal.
 *  - Everything is wrapped: this hook can never throw into, or slow down, the payment flow.
 * ------------------------------------------------------------------ */
mpesaTransactionSchema.pre('save', function markSaleLinked(next) {
  this.$locals.saleJustLinked = !!this.saleId && this.isModified('saleId');
  next();
});

mpesaTransactionSchema.post('save', function crmCapture(doc) {
  try {
    if (!doc.$locals || !doc.$locals.saleJustLinked) return;
    doc.$locals.saleJustLinked = false;
    if (doc.status !== 'SUCCESS' || !doc.saleId) return;

    const businessId = doc.businessId;
    const saleId = doc.saleId;
    const t = setTimeout(() => {
      try {
        const crm = require('../services/crm.service');
        if (crm && typeof crm.onSaleCompleted === 'function') crm.onSaleCompleted(businessId, saleId);
      } catch (err) {
        console.error('[crm] capture hook failed', err.message);
      }
    }, 3000);
    if (t.unref) t.unref();
  } catch (err) {
    console.error('[crm] capture hook error', err.message);
  }
});

module.exports = model('MpesaTransaction', mpesaTransactionSchema);