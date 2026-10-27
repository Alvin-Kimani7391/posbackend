const { Schema, model } = require('mongoose');
const { AGE_MODES, EMPTIES_MODES } = require('../constants/liquor');

const hhmm = { type: String, match: /^([01]?\d|2[0-3]):[0-5]\d$/ };
const daySchema = new Schema({ day: { type: Number, min: 0, max: 6, required: true }, closed: { type: Boolean, default: false }, open: hhmm, close: hhmm }, { _id: false }); // close <= open means "after midnight" (open 10:00, close 02:00)

const liquorSettingsSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },
  licence: {
    number: { type: String, trim: true }, type: { type: String, trim: true }, issuer: { type: String, trim: true }, premises: { type: String, trim: true },
    issuedAt: { type: Date }, expiresAt: { type: Date },
  },
  blockWhenLicenceExpired: { type: Boolean, default: true },
  licenceWarnDays: { type: Number, default: 30, min: 0, max: 365 },
  tradingHours: { enabled: { type: Boolean, default: false }, byDay: { type: [daySchema], default: [] } },
  closedDates: { type: [new Schema({ date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, required: true }, reason: { type: String, trim: true, maxlength: 100 } }, { _id: false })], default: [] }, // dry days: elections, holidays, county notices
  age: { minAge: { type: Number, default: 18, min: 16, max: 25 }, mode: { type: String, enum: AGE_MODES, default: 'CONFIRM' } },
  maxBottlesPerSale: { type: Number, default: 0, min: 0 }, // 0 = no limit (stops bulk re-selling when the county requires it)
  emptiesMode: { type: String, enum: EMPTIES_MODES, default: 'TRACK' },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
module.exports = model('LiquorSettings', liquorSettingsSchema);
