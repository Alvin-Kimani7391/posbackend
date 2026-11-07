const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

/**
 * Goods from a RECEIVED purchase that are sent back to the supplier (damaged, wrong item, expired, quality, oversupply...).
 * Making a return, in one transaction:
 *   1. takes the stock back out of the pool it was received into (retail / warehouse), with batches and serial numbers,
 *   2. credits the value of the goods (what the purchase line cost, VAT included) against what the shop owes the supplier:
 *        - first against the purchase's unpaid balance (appliedToBalance),
 *        - anything beyond that was already paid, so the supplier owes the shop a refund (refundDue).
 * Supplier.currentBalance goes down by the whole credit (a negative balance = the supplier owes the shop).
 * Recording a refund received brings that balance back up.  All money is integer cents.
 */
const lineSchema = new Schema({
  itemIndex: { type: Number, required: true },        // position of the line on the purchase
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  variantId: { type: Schema.Types.ObjectId, ref: 'ProductVariant' },
  nameSnapshot: String,
  quantity: { type: Number, required: true, min: 0.001 },      // in the purchase unit
  unitName: String,
  unitFactor: { type: Number, default: 1 },
  baseQuantity: { type: Number, required: true },               // stock removed, in base units
  unitCost: { type: Number, default: 0 },                       // cents per purchase unit (ex-VAT, as bought)
  total: { type: Number, default: 0 },                          // cents credited for this line (incl. VAT / net of discount)
  location: { type: String, enum: ['RETAIL', 'WAREHOUSE'], default: 'RETAIL' },
  warehouseId: { type: Schema.Types.ObjectId, ref: 'Warehouse' },
  serialNumbers: [String],
  batches: [{ _id: false, batchId: Schema.Types.ObjectId, batchNumber: String, quantity: Number }],
}, { _id: false });

const refundSchema = new Schema({
  amount: { type: Number, required: true },
  method: { type: String, enum: ['CASH', 'MPESA', 'BANK', 'CHEQUE', 'OTHER'], default: 'CASH' },
  reference: String,
  note: String,
  at: { type: Date, default: Date.now },
  by: { type: Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const purchaseReturnSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  number: { type: String, required: true },                      // PR-000001
  purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
  purchaseNumber: String,
  supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
  returnDate: { type: Date, default: Date.now },
  reason: { type: String, enum: ['DAMAGED', 'EXPIRED', 'WRONG_ITEM', 'QUALITY', 'OVERSUPPLY', 'PRICE_DISPUTE', 'RECALL', 'OTHER'], required: true },
  reasonNote: String,
  creditNoteNumber: String,                                      // the supplier's credit note, if they issued one
  lines: { type: [lineSchema], validate: (v) => v.length > 0 },

  totalCredit: { type: Number, default: 0 },                     // value returned
  appliedToBalance: { type: Number, default: 0 },                // part that reduced what is still owed
  refundDue: { type: Number, default: 0 },                       // part already paid: the supplier owes the shop
  refundReceived: { type: Number, default: 0 },
  refundStatus: { type: String, enum: ['NONE', 'PENDING', 'PARTIAL', 'SETTLED', 'CREDIT_HELD'], default: 'NONE' },
  refunds: [refundSchema],

  // snapshot so the screens can show "before -> after" without recomputing
  balanceBefore: { type: Number, default: 0 },                   // purchase balance
  balanceAfter: { type: Number, default: 0 },
  supplierBalanceBefore: { type: Number, default: 0 },
  supplierBalanceAfter: { type: Number, default: 0 },

  notes: String,
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

purchaseReturnSchema.index({ businessId: 1, number: 1 }, { unique: true });
purchaseReturnSchema.index({ businessId: 1, supplierId: 1, createdAt: -1 });
purchaseReturnSchema.index({ businessId: 1, purchaseId: 1 });
purchaseReturnSchema.index({ businessId: 1, branchId: 1, returnDate: -1 });

moneyFields(
  purchaseReturnSchema,
  ['totalCredit', 'appliedToBalance', 'refundDue', 'refundReceived', 'balanceBefore', 'balanceAfter', 'supplierBalanceBefore', 'supplierBalanceAfter'],
  { lines: ['unitCost', 'total'], refunds: ['amount'] }
);

module.exports = model('PurchaseReturn', purchaseReturnSchema);