const { Schema, model } = require('mongoose');

const hhmm = { type: String, match: /^\d{1,2}:\d{2}$/ };
const feeType = { type: String, enum: ['NONE', 'FLAT', 'PERCENT', 'HOURLY', 'FULL_NIGHT'], default: 'NONE' };

/**
 * Everything the owner decides about rooms, in one document per business: the check-in / check-out times, what early
 * arrival and late departure cost, deposits, cancellations, taxes and levies, and what guests may do themselves.
 * Money is integer cents. Times are in the business time zone.
 */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true },

  checkIn: { time: { ...hhmm, default: '14:00' } },                    // standard check-in time
  checkOut: { time: { ...hhmm, default: '11:00' } },                   // standard check-out time

  // Arrival BEFORE the standard check-in time. Pick the tier with the latest `from` that is at or before the arrival time.
  // Arriving before the earliest tier applies `beforeFirstTier` (FULL_NIGHT = the previous night is charged; DENY = not allowed).
  earlyCheckIn: {
    allowed: { type: Boolean, default: true },
    tiers: { type: [new Schema({ from: { ...hhmm, required: true }, feeType, value: { type: Number, default: 0, min: 0 } }, { _id: false })], default: [{ from: '12:00', feeType: 'NONE', value: 0 }, { from: '08:00', feeType: 'PERCENT', value: 50 }] },
    beforeFirstTier: { type: String, enum: ['FULL_NIGHT', 'DENY'], default: 'FULL_NIGHT' },
    requiresRoomReady: { type: Boolean, default: true },               // a dirty room cannot be given early
  },
  // Departure AFTER the standard check-out time. Free for `graceMinutes`, then the first tier whose `until` is not yet passed.
  // Leaving after the last tier applies `afterLastTier`.
  lateCheckOut: {
    allowed: { type: Boolean, default: true },
    graceMinutes: { type: Number, default: 15, min: 0, max: 240 },
    tiers: { type: [new Schema({ until: { ...hhmm, required: true }, feeType, value: { type: Number, default: 0, min: 0 } }, { _id: false })], default: [{ until: '14:00', feeType: 'PERCENT', value: 25 }, { until: '18:00', feeType: 'PERCENT', value: 50 }] },
    afterLastTier: { type: String, enum: ['FULL_NIGHT', 'DENY'], default: 'FULL_NIGHT' },
  },

  stay: {
    minNights: { type: Number, default: 1, min: 1 },
    maxNights: { type: Number, default: 60, min: 1 },
    maxAdvanceDays: { type: Number, default: 540, min: 1 },
    allowDayUse: { type: Boolean, default: false },
    dayUse: { hours: { type: Number, default: 6, min: 1, max: 12 }, percentOfNightly: { type: Number, default: 50, min: 0, max: 100 } },
    earlyDeparture: { type: String, enum: ['CHARGE_BOOKED', 'CHARGE_USED'], default: 'CHARGE_BOOKED' },  // guest leaves before the booked date
    requireIdAtCheckIn: { type: Boolean, default: true },              // guest register: name + ID or passport
    requirePhone: { type: Boolean, default: true },
    allowOverrideRate: { type: Boolean, default: true },
  },

  deposit: {
    required: { type: Boolean, default: false },
    type: { type: String, enum: ['FLAT', 'PERCENT', 'FIRST_NIGHT'], default: 'FIRST_NIGHT' },
    value: { type: Number, default: 0, min: 0 },
    requiredBeforeCheckIn: { type: Boolean, default: false },          // false = the deposit is advised, true = check-in blocked until it is paid
  },
  cancellation: {
    freeUntilHours: { type: Number, default: 24, min: 0 },             // hours before check-in that cancelling is free
    penaltyType: { type: String, enum: ['NONE', 'FIRST_NIGHT', 'PERCENT', 'FLAT'], default: 'FIRST_NIGHT' },
    value: { type: Number, default: 0, min: 0 },
  },
  noShow: {
    afterHours: { type: Number, default: 12, min: 1, max: 72 },        // hours after the expected check-in time before the booking may be released
    chargePenalty: { type: Boolean, default: true },                   // same penalty as a late cancellation
    autoRelease: { type: Boolean, default: false },                    // false = reception decides; true = the job marks no-shows
  },

  tax: {
    roomTaxRate: { type: Number, min: 0, max: 100 },                   // null = the business default VAT rate (0 if not VAT-registered)
    levies: { type: [new Schema({ name: { type: String, required: true, trim: true }, percent: { type: Number, required: true, min: 0, max: 100 }, taxRate: { type: Number, default: 0, min: 0, max: 100 } }, { _id: false })], default: [] }, // e.g. tourism levy, charged on the room charge
  },

  selfService: {
    selfCheckIn: { type: Boolean, default: false },                    // guest confirms arrival by scanning the room QR + booking code
    selfCheckInOpensHoursBefore: { type: Number, default: 0, min: 0, max: 24 },
    requireDepositPaidForSelfCheckIn: { type: Boolean, default: true },
    selfCheckOut: { type: Boolean, default: true },                    // guest may check out from the room when nothing is owed
    guestPinRequired: { type: Boolean, default: true },                // QR actions in a room need the PIN printed on the registration card
    guestPinLength: { type: Number, default: 4, min: 4, max: 8 },
  },
  housekeeping: {
    autoCreateTasks: { type: Boolean, default: true },
    requireInspection: { type: Boolean, default: false },              // a cleaned room is not sellable until inspected
    stayoverCleaning: { type: Boolean, default: true },
  },
  roomService: {
    enabled: { type: Boolean, default: true },
    autoPostToFolio: { type: Boolean, default: true },                 // served room orders are charged to the room automatically
    hoursStart: hhmm, hoursEnd: hhmm,                                  // room service hours (unset = always)
    minOrderCents: { type: Number, default: 0, min: 0 },
    deliveryFeeCents: { type: Number, default: 0, min: 0 },
  },
}, { timestamps: true });

module.exports = model('AccommodationSettings', s);
