const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const STATUSES = ['CHECKED_IN', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY', 'COLLECTED', 'CANCELLED'];

const labourSchema = new Schema({
  description: { type: String, required: true, trim: true },
  hours: { type: Number, default: 1, min: 0.1 },  // billed hours
  rate: { type: Number, required: true },         // integer cents per hour (or the fixed price when hours = 1)
  mechanicId: { type: Schema.Types.ObjectId, ref: 'User' },
  done: { type: Boolean, default: false },
  doneAt: { type: Date },
});

const partSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  nameSnapshot: { type: String },
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true },
  cost: { type: Number, default: 0 },
  taxRate: { type: Number, default: 0 },
  issued: { type: Boolean, default: false },
  issuedAt: { type: Date },
  issuedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  batchAllocations: [{ _id: false, batchId: Schema.Types.ObjectId, batchNumber: String, expiryDate: Date, quantity: Number }],
});

const paymentSchema = new Schema({
  type: { type: String, enum: ['DEPOSIT', 'PAYMENT', 'REFUND'], required: true },
  method: { type: String, enum: ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'], required: true },
  amount: { type: Number, required: true, min: 1 },
  reference: { type: String },
  at: { type: Date, default: Date.now },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  verified: { type: Boolean, default: false },
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' },
});

const historySchema = new Schema({
  at: { type: Date, default: Date.now },
  status: { type: String },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  note: { type: String },
}, { _id: false });

const jobCardSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    jobNumber: { type: String, required: true },

    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', required: true },
    plate: { type: String, required: true },            // snapshots, so the card stays readable if the vehicle changes
    vehicleLabel: { type: String },                     // "Toyota Fielder 2012"
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },

    odometerIn: { type: Number, min: 0, required: true },
    odometerOut: { type: Number, min: 0 },
    fuelLevel: { type: String, enum: ['EMPTY', 'QUARTER', 'HALF', 'THREE_QUARTER', 'FULL'] },
    conditionNotes: { type: String, trim: true },       // dents, scratches, warning lights at check-in
    itemsLeftInCar: [{ type: String, trim: true }],     // spare wheel, jack, documents ...
    customerSuppliedParts: [{ type: String, trim: true }], // parts the customer brought; not charged, not stocked

    complaint: { type: String, required: true, trim: true },
    diagnosis: { type: String, trim: true },
    mechanicId: { type: Schema.Types.ObjectId, ref: 'User' },
    promisedDate: { type: Date },

    status: { type: String, enum: STATUSES, default: 'CHECKED_IN' },

    // Comeback = the same vehicle returns during the warranty of an earlier collected job.
    comebackOf: { type: Schema.Types.ObjectId, ref: 'JobCard' },
    isWarrantyRepair: { type: Boolean, default: false }, // manager-approved: no charge to the customer

    labourLines: { type: [labourSchema], default: [] },
    labourTotal: { type: Number, default: 0 },
    labourTaxRate: { type: Number, default: 0 },
    taxInclusive: { type: Boolean, default: true },
    parts: { type: [partSchema], default: [] },
    partsTotal: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    approvedTotal: { type: Number, default: 0 },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvalChannel: { type: String, enum: ['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP'] },
    approvalNote: { type: String },

    payments: { type: [paymentSchema], default: [] },
    paid: { type: Number, default: 0 },
    waived: { type: Number, default: 0 },
    waiveReason: { type: String },
    balance: { type: Number, default: 0 },

    qualityCheck: { passed: Boolean, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String, roadTest: Boolean },

    workWarrantyDays: { type: Number, min: 0, default: 0 }, // guarantee on the work done, set at collection
    workWarrantyUntil: { type: Date },
    nextServiceKm: { type: Number },
    nextServiceDate: { type: Date },

    settlementSaleId: { type: Schema.Types.ObjectId, ref: 'Sale' },
    collectedAt: { type: Date },
    collectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    collectedByName: { type: String },
    collectorIdChecked: { type: Boolean },
    cancelReason: { type: String },

    history: { type: [historySchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

jobCardSchema.index({ businessId: 1, jobNumber: 1 }, { unique: true });
jobCardSchema.index({ businessId: 1, branchId: 1, status: 1 });
jobCardSchema.index({ businessId: 1, vehicleId: 1, createdAt: -1 });
jobCardSchema.index({ businessId: 1, customerPhone: 1 });

moneyFields(jobCardSchema, ['labourTotal', 'partsTotal', 'tax', 'total', 'approvedTotal', 'paid', 'waived', 'balance'], { labourLines: ['rate'], parts: ['unitPrice', 'cost'], payments: ['amount'] });

module.exports = model('JobCard', jobCardSchema);
module.exports.STATUSES = STATUSES;