const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const PAYMENT_METHODS = ['CASH', 'MPESA', 'CARD', 'BANK', 'CREDIT', 'OTHER'];
const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIAL'];

const paymentSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    saleId: { type: Schema.Types.ObjectId, ref: 'Sale', index: true },
    shiftId: { type: Schema.Types.ObjectId, ref: 'CashShift', index: true }, // lets shift close reconcile cash without joining through Sale
    refundId: { type: Schema.Types.ObjectId, ref: 'Refund' }, // set when this Payment record represents money paid OUT as a refund
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },

    method: { type: String, enum: PAYMENT_METHODS, required: true },
    // "provider" is a free-text label for which rail was used within a method
    // (e.g. 'manual' today for MPESA/CARD/BANK; 'safaricom-stk' once the
    // M-PESA integration lands). Never hard-code provider logic elsewhere.
    provider: { type: String, default: 'manual' },

    amount: { type: Number, required: true }, // integer cents
    reference: { type: String, trim: true }, // till/paybill code, card slip number, bank ref, etc - typed in by the cashier for now
    externalTransactionId: { type: String, trim: true }, // reserved for the real M-PESA/card gateway transaction id later

    // Cash-specific breakdown - only meaningful when method === 'CASH'.
    amountTendered: { type: Number },
    changeGiven: { type: Number },

    status: { type: String, enum: PAYMENT_STATUSES, default: 'SUCCESS' },
    metadata: { type: Schema.Types.Mixed },

    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    completedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

paymentSchema.index({ businessId: 1, saleId: 1 });
paymentSchema.index({ businessId: 1, externalTransactionId: 1 }, { sparse: true });
paymentSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });

moneyFields(paymentSchema, ['amount', 'amountTendered', 'changeGiven']);

const Payment = model('Payment', paymentSchema);
module.exports = Payment;
module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.PAYMENT_STATUSES = PAYMENT_STATUSES;
