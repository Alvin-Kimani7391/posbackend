const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const STATUSES = ['APPRAISED', 'ACCEPTED', 'APPLIED', 'CANCELLED', 'REVERSED'];
const ID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'ALIEN_ID'];

/**
 * A used device a customer hands in as part-payment on a purchase.
 * APPRAISED (offer made) -> ACCEPTED (customer agrees, ownership declared, checks passed) -> APPLIED (used on a sale;
 * the device is now in stock as a used unit). REVERSED = the sale was cancelled and the device handed back.
 */
const tradeInSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    number: { type: String, required: true },
    status: { type: String, enum: STATUSES, default: 'APPRAISED' },

    // Who is selling it. A shop that buys used phones must be able to say who it bought each one from.
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    sellerName: { type: String, required: true, trim: true },
    sellerPhone: { type: String, required: true, trim: true },
    idType: { type: String, enum: ID_TYPES, required: true },
    idNumber: { type: String, required: true, trim: true, uppercase: true },

    device: {
      category: { type: String, enum: ['PHONE', 'TABLET', 'LAPTOP', 'OTHER'], default: 'PHONE' },
      brand: { type: String, required: true, trim: true },
      model: { type: String, required: true, trim: true },
      storage: { type: String, trim: true },
      color: { type: String, trim: true },
      serialNumber: { type: String, required: true, trim: true, uppercase: true }, // IMEI for phones
      serialKind: { type: String, enum: ['serial', 'imei'], default: 'serial' },
      grade: { type: String, enum: ['A', 'B', 'C', 'D'], required: true },          // A = like new ... D = heavy wear / faulty
      accessories: [{ type: String, trim: true }],
      notes: { type: String, trim: true },
    },
    // Staff attest each check. Account locks and stolen-status are mandatory to ACCEPT.
    checklist: {
      powersOn: { type: Boolean, default: false },
      accountLocksRemoved: { type: Boolean, default: false },   // iCloud / Google (FRP) / Mi account signed out
      imeiMatchesDevice: { type: Boolean, default: false },     // dialled *#06# / matches box and settings
      notReportedStolen: { type: Boolean, default: false },     // checked against the regulator's IMEI check
    },

    offer: { type: Number, required: true, min: 1 },        // integer cents: credit given to the customer
    resalePrice: { type: Number, required: true, min: 1 },  // integer cents: what the shop will sell it for
    flags: [{ type: String }],                              // FREQUENT_SELLER, RETURNED_TO_US ...
    needsApproval: { type: Boolean, default: false },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    expiresAt: { type: Date, required: true },

    ownershipDeclared: { type: Boolean, default: false },   // seller confirmed they own the device and it is not encumbered
    acceptedAt: { type: Date },
    acceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    saleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },   // the "(Used)" product the device was received under
    serialId: { type: Schema.Types.ObjectId, ref: 'SerialNumber' },
    serialSnapshot: { type: Schema.Types.Mixed },                 // prior state when the unit was one WE sold earlier (restored on reversal)

    cancelReason: { type: String },
    appraisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    history: [{ _id: false, at: Date, event: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
  },
  { timestamps: true }
);

tradeInSchema.index({ businessId: 1, number: 1 }, { unique: true });
tradeInSchema.index({ businessId: 1, 'device.serialNumber': 1, status: 1 });
tradeInSchema.index({ businessId: 1, idNumber: 1, createdAt: -1 });
tradeInSchema.index({ businessId: 1, branchId: 1, status: 1 });

moneyFields(tradeInSchema, ['offer', 'resalePrice']);

module.exports = model('TradeIn', tradeInSchema);
module.exports.STATUSES = STATUSES;
module.exports.ID_TYPES = ID_TYPES;