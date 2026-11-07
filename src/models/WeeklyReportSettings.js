const { Schema, model } = require('mongoose');

/**
 * Singleton (key = 'weekly'). When the platform emails the weekly shop-performance report.
 * Default: every Saturday 10:00 (shop-owner time, Africa/Nairobi). The platform admin can add more slots.
 * `ranKeys` remembers which slots already fired ("2026-11-07T10:00") so a restart or a second instance never double-sends.
 */
const slotSchema = new Schema({
  day: { type: Number, min: 0, max: 6, required: true },            // 0 = Sunday ... 6 = Saturday
  time: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ }, // "HH:MM" 24h
}, { _id: false });

const weeklyReportSettingsSchema = new Schema({
  key: { type: String, default: 'weekly', unique: true },
  enabled: { type: Boolean, default: true },
  timezone: { type: String, default: 'Africa/Nairobi' },
  slots: { type: [slotSchema], default: () => [{ day: 6, time: '10:00' }] },
  ranKeys: { type: [String], default: [] },
  lastRun: {
    at: Date, key: String, trigger: { type: String, enum: ['schedule', 'manual'] },
    businesses: Number, sent: Number, skipped: Number, failed: Number,
  },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = model('WeeklyReportSettings', weeklyReportSettingsSchema);
