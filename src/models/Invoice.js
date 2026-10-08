const { Schema, model } = require('mongoose');
const { INVOICE_STATUSES, INVOICE_KINDS } = require('../constants/billing');

const invoiceSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    subscriptionId: { type: Schema.Types.ObjectId, ref: 'Subscription', required: true },
    number: { type: String, required: true, unique: true },
    kind: { type: String, enum: INVOICE_KINDS, required: true },

    planRun: { type: Number, default: 1 },
    phaseKey: { type: String },
    sequence: { type: Number }, // NO default on purpose: ad-hoc invoices must not be in the unique index below

    description: { type: String, required: true, trim: true },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    dueDate: { type: Date, required: true },

    baseAmount: { type: Number, required: true, min: 0 }, // as originally generated (used to split instalments)
    amount: { type: Number, required: true, min: 0 }, // current amount (admin may adjust)
    amountPaid: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: INVOICE_STATUSES, default: 'PENDING' },
    paidAt: { type: Date },

    voidedAt: { type: Date },
    voidReason: { type: String },
    adjustments: [{ _id: false, at: Date, by: String, from: Number, to: Number, reason: String }],

    meta: { type: Schema.Types.Mixed }, // e.g. { metric, value, tierLabel } for tiered invoices
    reminderKeys: [{ type: String }],
    createdBy: { type: String, default: 'SYSTEM' },
  },
  { timestamps: true }
);

// Guarantees the engine can never issue the same scheduled invoice twice (even with several app instances).
invoiceSchema.index(
  { subscriptionId: 1, planRun: 1, phaseKey: 1, sequence: 1 },
  { unique: true, partialFilterExpression: { sequence: { $exists: true } } }
);
invoiceSchema.index({ subscriptionId: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ status: 1, dueDate: 1 });

module.exports = model('Invoice', invoiceSchema);