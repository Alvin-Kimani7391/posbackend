const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const STATUSES = ['RECEIVED', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'READY', 'COLLECTED', 'UNREPAIRABLE', 'CANCELLED'];

const partSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant', default: null },
  nameSnapshot: { type: String },
  quantity: { type: Number, required: true, min: 0.001 },
  unitPrice: { type: Number, required: true }, // integer cents, from the product's selling price at estimate time
  cost: { type: Number, default: 0 },          // integer cents per unit, for margin
  taxRate: { type: Number, default: 0 },       // percent, snapshotted from the product at estimate time
  issued: { type: Boolean, default: false },   // stock has been taken for this job
  issuedAt: { type: Date },
  issuedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  batchAllocations: [{ _id: false, batchId: Schema.Types.ObjectId, batchNumber: String, expiryDate: Date, quantity: Number }],
});

const paymentSchema = new Schema({
  type: { type: String, enum: ['DEPOSIT', 'PAYMENT', 'REFUND'], required: true },
  method: { type: String, enum: ['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER'], required: true },
  amount: { type: Number, required: true, min: 1 }, // integer cents
  reference: { type: String },
  at: { type: Date, default: Date.now },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  // true = M-PESA confirmed against a successful transaction; CASH/CARD/BANK are attested by staff (same as at the till).
  verified: { type: Boolean, default: false },
  paymentId: { type: Schema.Types.ObjectId, ref: 'Payment' }, // the Payment record (cash drawer / payment reports)
});

const historySchema = new Schema({
  at: { type: Date, default: Date.now },
  status: { type: String },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
  note: { type: String },
}, { _id: false });

const repairJobSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    jobNumber: { type: String, required: true },

    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },

    device: {
      brand: { type: String, trim: true },
      model: { type: String, trim: true },
      serialNumber: { type: String, trim: true, uppercase: true }, // serial / IMEI as given at the counter
      condition: { type: String, trim: true },                      // scratches, cracked screen, ...
      accessories: [{ type: String, trim: true }],                  // charger, case, SIM tray, ...
    },
    serialId: { type: Schema.Types.ObjectId, ref: 'SerialNumber' }, // set when the device was sold by this shop
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },

    fault: { type: String, required: true, trim: true },
    diagnosis: { type: String, trim: true },
    technicianId: { type: Schema.Types.ObjectId, ref: 'User' },
    promisedDate: { type: Date },

    isWarrantyRepair: { type: Boolean, default: false }, // customer is charged nothing
    warrantyClaimId: { type: Schema.Types.ObjectId, ref: 'WarrantyClaim' },

    status: { type: String, enum: STATUSES, default: 'RECEIVED' },

    // Money (integer cents, shown as KES in JSON like the rest of the API)
    labour: { type: Number, default: 0 },
    labourTaxRate: { type: Number, default: 0 }, // percent, snapshotted from the business when the job was opened
    taxInclusive: { type: Boolean, default: true }, // snapshot of the business tax mode
    tax: { type: Number, default: 0 },
    parts: { type: [partSchema], default: [] },
    partsTotal: { type: Number, default: 0 },
    total: { type: Number, default: 0 },          // what the customer owes (0 for warranty repairs)
    approvedTotal: { type: Number, default: 0 },  // total at the moment the customer approved
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvalChannel: { type: String, enum: ['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP'] },
    approvalNote: { type: String },

    payments: { type: [paymentSchema], default: [] },
    paid: { type: Number, default: 0 },
    waived: { type: Number, default: 0 },
    waiveReason: { type: String },
    balance: { type: Number, default: 0 },

    settlementSaleId: { type: Schema.Types.ObjectId, ref: 'Sale' }, // the invoice/receipt created at collection (this is what reports count as revenue)
    collectedAt: { type: Date },
    collectedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // staff member who handed it over
    collectedByName: { type: String },                          // who took it
    collectorIdChecked: { type: Boolean },
    cancelReason: { type: String },

    history: { type: [historySchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

repairJobSchema.index({ businessId: 1, jobNumber: 1 }, { unique: true });
repairJobSchema.index({ businessId: 1, branchId: 1, status: 1 });
repairJobSchema.index({ businessId: 1, serialId: 1 });
repairJobSchema.index({ businessId: 1, customerPhone: 1 });

moneyFields(repairJobSchema, ['labour', 'partsTotal', 'tax', 'total', 'approvedTotal', 'paid', 'waived', 'balance'], { parts: ['unitPrice', 'cost'], payments: ['amount'] });

module.exports = model('RepairJob', repairJobSchema);
module.exports.STATUSES = STATUSES;