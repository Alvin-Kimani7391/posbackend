const { Schema, model } = require('mongoose');
const moneyPaths = require('../utils/moneyDeepPlugin');
const s = new Schema({
  businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true },
  billId: { type: Schema.Types.ObjectId, ref: 'RestaurantBill', required: true }, orderId: Schema.Types.ObjectId, saleId: Schema.Types.ObjectId,
  waiterId: { type: Schema.Types.ObjectId, ref: 'User' },
  amount: { type: Number, required: true, min: 1 },
  method: { type: String, enum: ['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER'], required: true },
  reference: String, paymentId: Schema.Types.ObjectId, shiftId: Schema.Types.ObjectId,
  allocations: [{ _id: false, userId: Schema.Types.ObjectId, amount: Number }],
  status: { type: String, enum: ['RECORDED', 'ALLOCATED', 'PAID_OUT'], default: 'RECORDED' },
  paidOutAt: Date, paidOutBy: Schema.Types.ObjectId, recordedBy: Schema.Types.ObjectId,
}, { timestamps: true });
s.index({ businessId: 1, branchId: 1, createdAt: -1 });
s.index({ businessId: 1, waiterId: 1, status: 1 });
moneyPaths(s, ['amount', 'allocations.amount']);
module.exports = model('TipRecord', s);
