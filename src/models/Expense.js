const { Schema, model } = require('mongoose');
const moneyFields = require('../utils/moneySchemaPlugin');

const EXPENSE_CATEGORIES = ['Rent', 'Electricity', 'Water', 'Transport', 'Salary', 'Packaging', 'Internet', 'Maintenance', 'Other'];

const expenseSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },

    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amount: { type: Number, required: true, min: 1 }, // integer cents
    description: { type: String, trim: true },

    paymentMethod: { type: String, enum: ['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER'], default: 'CASH' },
    reference: { type: String, trim: true },
    receiptImage: { type: String },

    expenseDate: { type: Date, default: Date.now },

    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: { type: String },
  },
  { timestamps: true }
);

expenseSchema.index({ businessId: 1, branchId: 1, expenseDate: -1 });
expenseSchema.index({ businessId: 1, category: 1 });
expenseSchema.index({ businessId: 1, status: 1 });

moneyFields(expenseSchema, ['amount']);

const Expense = model('Expense', expenseSchema);
module.exports = Expense;
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
