const { Schema, model } = require('mongoose');

/** Singleton (key = 'billing'). The platform's own PayHero credentials live here, encrypted like shop credentials. */
const platformSettingsSchema = new Schema(
  {
    key: { type: String, default: 'billing', unique: true },
    billingEnabled: { type: Boolean, default: false }, // master switch: off = no invoices, emails, locks
    defaultPlanKey: { type: String, default: 'standard' },

    stk: {
      enabled: { type: Boolean, default: false },
      provider: { type: String, enum: ['payhero'], default: 'payhero' },
      channelId: { type: String, trim: true },
      credentialsBlob: { type: String, select: false },
      credentialsSetAt: { type: Date },
      updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },

    manual: {
      enabled: { type: Boolean, default: true },
      methodLabel: { type: String, default: 'Till (Buy Goods)', trim: true },
      number: { type: String, trim: true }, // till / paybill number shown to owners
      accountName: { type: String, trim: true }, // name that appears on the M-PESA confirmation
      accountReference: { type: String, trim: true }, // e.g. "Use your business name as account"
      phone: { type: String, trim: true },
      instructions: { type: String, maxlength: 1000, default: '' },
    },

    enforcement: {
      autoSuspendEnabled: { type: Boolean, default: true },
      graceDays: { type: Number, default: 7, min: 0, max: 90 }, // days after the oldest overdue due-date
    },

    reminders: {
      beforeDueDays: { type: [Number], default: [3] },
      overdueDays: { type: [Number], default: [1, 3, 7] },
      trialEndingDays: { type: [Number], default: [2] },
    },

    alertEmails: [{ type: String, trim: true, lowercase: true }], // platform staff who get billing emails
    contact: { supportPhone: { type: String, trim: true }, supportEmail: { type: String, trim: true } },
  },
  { timestamps: true }
);

module.exports = model('PlatformSettings', platformSettingsSchema);