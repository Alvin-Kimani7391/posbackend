const { Schema, model } = require('mongoose');
const { PHASE_TYPES, PRICING_MODES, TIER_METRICS, BILLING_CURRENCIES } = require('../constants/billing');

const tierSchema = new Schema(
  {
    label: { type: String, trim: true },
    upTo: { type: Number, default: null }, // inclusive upper bound of the metric; null = no upper limit
    amountCents: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const phaseSchema = new Schema(
  {
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: PHASE_TYPES, required: true },

    durationDays: { type: Number }, // TRIAL

    durationMonths: { type: Number, default: null }, // INSTALLMENTS (required) / RECURRING (null = open-ended)
    installments: { type: Number }, // INSTALLMENTS: how many equal-ish monthly parts
    totalAmountCents: { type: Number, min: 0 }, // INSTALLMENTS

    intervalMonths: { type: Number, default: 1 }, // RECURRING
    pricingMode: { type: String, enum: PRICING_MODES }, // RECURRING
    amountCents: { type: Number, min: 0 }, // RECURRING + FLAT
    tierMetric: { type: String, enum: TIER_METRICS, default: 'TRANSACTION_COUNT' }, // RECURRING + TIERED
    tiers: [tierSchema],

    dueAfterDays: { type: Number, default: 0, min: 0 }, // invoice due this many days after it is issued
  },
  { _id: false }
);

const billingPlanSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    // Every amount in the plan's phases/tiers is in this currency. A business is only ever put on a plan of its own currency.
  currency: { type: String, enum: BILLING_CURRENCIES, default: 'KES' }, // currency of every amount on this document

    isActive: { type: Boolean, default: true },
    businessTypes: [{ type: String, trim: true }], // base plan new businesses of these types start on
    phases: { type: [phaseSchema], validate: [(v) => v.length > 0, 'A plan needs at least one phase'] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = model('BillingPlan', billingPlanSchema);