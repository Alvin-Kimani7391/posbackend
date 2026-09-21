const Expense = require('../models/Expense');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');

async function listExpenses(businessId, { branchId, category, status, from, to, page, limit }) {
  const filter = { businessId };
  if (branchId) filter.branchId = branchId;
  if (category) filter.category = category;
  if (status) filter.status = status;
  if (from || to) {
    filter.expenseDate = {};
    if (from) filter.expenseDate.$gte = new Date(from);
    if (to) filter.expenseDate.$lte = new Date(to);
  }

  const [items, total] = await Promise.all([
    Expense.find(filter).populate('createdBy', 'name').sort({ expenseDate: -1 }).skip((page - 1) * limit).limit(limit),
    Expense.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getExpense(businessId, id) {
  const expense = await Expense.findOne({ _id: id, businessId }).populate('createdBy', 'name').populate('approvedBy', 'name');
  if (!expense) throw ApiError.notFound('Expense not found');
  return expense;
}

async function createExpense(businessId, branchId, user, data) {
  // OWNER/ADMIN don't need their own spending approved by someone else.
  const autoApprove = user.role === ROLES.OWNER || user.role === ROLES.ADMIN;

  const expense = await Expense.create({
    ...data, businessId, branchId, createdBy: user._id,
    status: autoApprove ? 'APPROVED' : 'PENDING',
    approvedBy: autoApprove ? user._id : undefined,
  });

  await AuditLog.create({ businessId, branchId, userId: user._id, action: 'expense.create', entityType: 'Expense', entityId: expense._id, newValue: { category: expense.category, amount: expense.amount } });
  return expense;
}

async function setExpenseStatus(businessId, userId, id, status, rejectionReason) {
  const expense = await Expense.findOne({ _id: id, businessId });
  if (!expense) throw ApiError.notFound('Expense not found');
  if (expense.status !== 'PENDING') throw ApiError.conflict('This expense has already been decided', 'ALREADY_DECIDED');

  expense.status = status;
  expense.approvedBy = userId;
  if (status === 'REJECTED') expense.rejectionReason = rejectionReason;
  await expense.save();

  await AuditLog.create({ businessId, branchId: expense.branchId, userId, action: `expense.${status.toLowerCase()}`, entityType: 'Expense', entityId: expense._id });
  return expense;
}

module.exports = { listExpenses, getExpense, createExpense, setExpenseStatus };
