const { Schema, model } = require('mongoose');
const { SUBSCRIPTION_STATUSES } = require('../constants/billing');

const lockSchema = new Schema(
  {
    active: { type: Boolean, default: false },
    reason: { type: String, enum: ['NON_PAYMENT', 'ADMIN'] },
    at: { type: Date },
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String },
  },
  { _id: false }
);

/** One per business. Denormalised money fields are refreshed by billing.service.reconcile(). All money = integer cents. */
const subscriptionSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
    planId: { type: Schema.Types.ObjectId, ref: 'BillingPlan' },
    planKey: { type: String },
    planName: { type: String },
    planRun: { type: Number, default: 1 }, // bumped whenever admin switches plan (keeps invoice sequences unique)

    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: 'TRIALING' },

    phaseKey: { type: String, default: null },
    phaseName: { type: String },
    phaseType: { type: String, default: null },
    phaseStartedAt: { type: Date },
    phaseEndsAt: { type: Date, default: null },
    phaseInvoiceCount: { type: Number, default: 0 },
    trialEndsAt: { type: Date },
    nextActionAt: { type: Date, default: null }, // when the engine next needs to do something

    creditCents: { type: Number, default: 0 },
    openBalanceCents: { type: Number, default: 0 },
    arrearsCents: { type: Number, default: 0 },
    oldestOverdueAt: { type: Date, default: null },
    totalPaidCents: { type: Number, default: 0 },
    lastPaymentAt: { type: Date },

    lock: { type: lockSchema, default: () => ({ active: false }) },
    lockExemptUntil: { type: Date }, // admin extension: no auto-lock before this date
    graceDaysOverride: { type: Number, min: 0, max: 90 }, // per-business override of the platform grace period

    notifiedKeys: [{ type: String }], // de-dupe for trial reminders etc.
    startedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date },
  },
  { timestamps: true }
);

subscriptionSchema.index({ nextActionAt: 1 });
subscriptionSchema.index({ status: 1 });
subscriptionSchema.index({ openBalanceCents: 1 });
subscriptionSchema.index({ arrearsCents: -1 });

module.exports = model('Subscription', subscriptionSchema);