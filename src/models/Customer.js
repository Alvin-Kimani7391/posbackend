const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');
const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/phone');

const LIFECYCLES = ['prospect', 'new', 'returning', 'frequent', 'vip', 'inactive'];

/**
 * Derived CRM stats. Written ONLY by crm.service (recomputeCustomers) - never edit by hand.
 * All money here is plain integer cents (deliberately NOT run through moneyFields, so the
 * values stay raw and cannot be double-converted).
 */
const crmSchema = new Schema(
  {
    lifecycle: { type: String, enum: LIFECYCLES, default: 'prospect' },
    isVip: { type: Boolean, default: false },
    purchaseCount: { type: Number, default: 0 },
    totalSpentCents: { type: Number, default: 0 }, // NET of refunds
    refundedCents: { type: Number, default: 0 },
    avgOrderCents: { type: Number, default: 0 },
    firstPurchaseAt: { type: Date },
    lastPurchaseAt: { type: Date },
    lastPurchaseCents: { type: Number, default: 0 },
    lastPaymentMethods: { type: [String], default: [] },
    lastMpesaReceipt: { type: String },
    recentPurchases: { type: Number, default: 0 }, // purchases inside CrmSettings.frequentWindowDays
    recentSpentCents: { type: Number, default: 0 },
    topCategories: { type: [{ _id: false, name: String, spentCents: Number, count: Number }], default: [] },
    paymentMethods: { type: [String], default: [] },
    paymentMix: { type: [{ _id: false, method: String, count: Number }], default: [] },
    computedAt: { type: Date },
  },
  { _id: false }
);

const customerSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    phoneNormalized: { type: String, trim: true }, // 2547XXXXXXXX - set automatically, identity key per business
    email: { type: String, trim: true },
    address: { type: String, trim: true },
    customerNumber: { type: String, trim: true },

    creditLimit: { type: Number, default: 0 }, // integer cents
    outstandingBalance: { type: Number, default: 0 }, // integer cents - kept in sync by CustomerLedger writes only
    loyaltyPoints: { type: Number, default: 0 },

    status: { type: String, enum: ['active', 'inactive'], default: 'active' },

    smsOptOut: { type: Boolean, default: false },

    // ---- CRM ----
    source: { type: String, enum: ['manual', 'pos', 'mpesa'], default: 'manual' }, // how the customer first entered the book
    tags: { type: [String], default: [] },
    duplicateOf: { type: Schema.Types.ObjectId, ref: 'Customer' }, // set by the phone backfill when two old records shared a number
    crm: { type: crmSchema, default: () => ({}) },
  },
  { timestamps: true }
);

customerSchema.index({ businessId: 1, phone: 1 });
customerSchema.index({ businessId: 1, customerNumber: 1 }, { unique: true, sparse: true });
customerSchema.index({ businessId: 1, name: 'text' });
// One customer per phone per business. Partial so customers without a valid phone are unaffected.
customerSchema.index(
  { businessId: 1, phoneNormalized: 1 },
  { unique: true, partialFilterExpression: { phoneNormalized: { $type: 'string' } } }
);
customerSchema.index({ businessId: 1, 'crm.lifecycle': 1 });
customerSchema.index({ businessId: 1, 'crm.totalSpentCents': -1 });
customerSchema.index({ businessId: 1, 'crm.lastPurchaseAt': -1 });

moneyFields(customerSchema, ['creditLimit', 'outstandingBalance']);

/* ---- keep phoneNormalized in sync no matter which code path writes the phone ---- */
customerSchema.pre('validate', function setPhoneNormalized(next) {
  if (this.isNew || this.isModified('phone')) {
    const n = normalizePhone(this.phone);
    this.phoneNormalized = n || undefined;
  }
  next();
});

function syncPhoneOnUpdate(next) {
  const u = this.getUpdate() || {};
  const target = u.$set || u;
  if (Object.prototype.hasOwnProperty.call(target, 'phone')) {
    const n = normalizePhone(target.phone);
    if (n) {
      target.phoneNormalized = n;
      if (u.$unset) delete u.$unset.phoneNormalized;
    } else {
      delete target.phoneNormalized;
      u.$unset = { ...(u.$unset || {}), phoneNormalized: '' };
    }
    this.setUpdate(u);
  }
  next();
}
customerSchema.pre('findOneAndUpdate', syncPhoneOnUpdate);
customerSchema.pre('updateOne', syncPhoneOnUpdate);

/* ---- friendly duplicate-phone error instead of a raw E11000 ---- */
const dupHandler = (err, _doc, next) => {
  if (err && err.code === 11000 && /phoneNormalized/.test(String(err.message))) {
    return next(new ApiError(409, 'A customer with this phone number already exists'));
  }
  return next(err);
};
['save', 'findOneAndUpdate', 'updateOne'].forEach((hook) => customerSchema.post(hook, dupHandler));

const Customer = model('Customer', customerSchema);
Customer.LIFECYCLES = LIFECYCLES;
module.exports = Customer;