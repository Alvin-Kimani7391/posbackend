const { Schema, model } = require('mongoose');

/**
 * Tracks one PayHero STK push attempt end-to-end. A Sale/Payment is only
 * ever created from a MpesaTransaction that has reached SUCCESS AND whose
 * saleId is still null (see mpesa.service.consumeForSale) - this is what
 * stops a cashier (or a compromised client) from typing in a fake MPESA
 * reference and having it accepted, the way CASH/CARD/BANK still can be.
 */
const mpesaTransactionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    reference: { type: String, required: true }, // our external_reference, e.g. "MPX-<nanoid>"
    phone: { type: String, required: true },
    amount: { type: Number, required: true }, // integer cents

    provider: { type: String, default: 'payhero' },
    checkoutRequestId: { type: String },
    providerReference: { type: String }, // PayHero's own "reference" field from the initiate response

    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED'], default: 'PENDING', index: true },

    // add to the schema, right after `status`:
failureType: { type: String, default: '' }, // 'wrong_pin' | 'insufficient_funds' | 'cancelled' | 'timeout' | 'in_progress' | 'system_error' | 'bad_credentials' | 'rate_limited' | 'send_failed' | 'failed' | ''

    mpesaReceiptNumber: { type: String },
    resultCode: { type: String },
    resultDesc: { type: String },

    rawInitiateResponse: { type: Schema.Types.Mixed },
    rawCallback: { type: Schema.Types.Mixed },

    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', default: null }, // set once consumed by a completed sale
    lastCheckedAt: { type: Date },
    escalatedAt: { type: Date }, // set once reapAbandoned() has notified management about a transaction unresolved for >10min - prevents duplicate escalation notifications
  },
  { timestamps: true }
);

mpesaTransactionSchema.index({ businessId: 1, reference: 1 }, { unique: true });
mpesaTransactionSchema.index({ status: 1, createdAt: 1 }); // for the reconciliation job

module.exports = model('MpesaTransaction', mpesaTransactionSchema);