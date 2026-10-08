const { Schema, model } = require('mongoose');

/** Per-business thresholds that drive the dynamic customer classification. */
const crmSettingsSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },

    newWindowDays: { type: Number, default: 30, min: 1 }, // "new customers" KPI window
    inactiveDays: { type: Number, default: 60, min: 7 }, // no purchase for this long => inactive
    frequentMinPurchases: { type: Number, default: 4, min: 2 }, // ...within frequentWindowDays => frequent
    frequentWindowDays: { type: Number, default: 30, min: 7 },
    vipMinSpendCents: { type: Number, default: 2000000, min: 0 }, // net spend (KES 20,000) => VIP. 0 disables.
    vipMinPurchases: { type: Number, default: 0, min: 0 }, // OR this many purchases => VIP. 0 disables.

    syncCursor: { type: Date }, // last Sale.updatedAt processed by the incremental sync
    lastRebuildAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = model('CrmSettings', crmSettingsSchema);