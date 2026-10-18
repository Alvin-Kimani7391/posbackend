const { Schema, model } = require('mongoose');
const moneyPaths = require('../utils/moneyDeepPlugin');
const { MEAL_PLANS } = require('../constants/hospitality');

/** A kind of room (Standard double, Suite...). The nightly rate lives here; rooms inherit it. All money is integer cents. */
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  name: { type: String, required: true, trim: true },
  code: { type: String, trim: true, uppercase: true },
  description: { type: String, trim: true },
  images: [{ type: String }],
  baseRate: { type: Number, required: true, min: 0 },                 // per room per night
  weekendRate: { type: Number, min: 0 },                              // optional: used on weekendDays
  weekendDays: { type: [Number], default: [5, 6] },                   // 0 = Sunday ... 6 = Saturday; the NIGHT that starts on that day
  seasonalRates: [{ _id: false, name: String, startDate: { type: String, required: true }, endDate: { type: String, required: true }, rate: { type: Number, required: true, min: 0 }, days: [Number] }], // YYYY-MM-DD inclusive
  baseOccupancy: { type: Number, default: 2, min: 1 },                // guests included in the rate
  maxAdults: { type: Number, default: 2, min: 1 },
  maxChildren: { type: Number, default: 0, min: 0 },
  extraAdultRate: { type: Number, default: 0, min: 0 },               // per extra adult per night (above baseOccupancy)
  childRate: { type: Number, default: 0, min: 0 },                    // per child per night (0 = children stay free)
  freeChildAge: { type: Number, default: 0 },                         // informational: children up to this age stay free
  mealPlanPrices: { type: Map, of: Number, default: {} },             // BED_BREAKFAST / HALF_BOARD / FULL_BOARD: add-on per adult per night
  amenities: [{ type: String, trim: true }],
  bedConfig: { type: String, trim: true },
  sizeSqm: { type: Number },
  taxRate: { type: Number, min: 0, max: 100 },                        // overrides the accommodation tax rate when set
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });
s.index({ businessId: 1, name: 1 }, { unique: true });
s.path('mealPlanPrices').validate((m) => !m || [...m.keys()].every((k) => MEAL_PLANS.includes(k) && k !== 'ROOM_ONLY'), 'Unknown meal plan');
moneyPaths(s, ['baseRate', 'weekendRate', 'seasonalRates.rate', 'extraAdultRate', 'childRate']);
module.exports = model('RoomType', s);
