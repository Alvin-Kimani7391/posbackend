const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const CustomerLedger = require('../models/CustomerLedger');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

async function listCustomers(businessId, { page, limit, search }) {
  const filter = { businessId };
  if (search) {
    filter.$or = [{ name: new RegExp(search, 'i') }, { phone: new RegExp(search, 'i') }, { customerNumber: new RegExp(search, 'i') }];
  }

  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Customer.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getCustomer(businessId, id) {
  const customer = await Customer.findOne({ _id: id, businessId });
  if (!customer) throw ApiError.notFound('Customer not found');
  return customer;
}

async function createCustomer(businessId, userId, data) {
  const customer = await Customer.create({ ...data, businessId });
  await AuditLog.create({ businessId, userId, action: 'customer.create', entityType: 'Customer', entityId: customer._id, newValue: { name: customer.name, phone: customer.phone } });
  return customer;
}

async function updateCustomer(businessId, userId, id, updates) {
  const customer = await Customer.findOne({ _id: id, businessId });
  if (!customer) throw ApiError.notFound('Customer not found');

  // creditLimit/outstandingBalance are never edited directly here -
  // outstandingBalance only ever changes via a ledger entry, and
  // creditLimit changes go through a dedicated action so they're audited
  // distinctly from a normal profile edit.
  const { creditLimit, outstandingBalance, ...safeUpdates } = updates;
  Object.assign(customer, safeUpdates);
  await customer.save();

  await AuditLog.create({ businessId, userId, action: 'customer.update', entityType: 'Customer', entityId: customer._id });
  return customer;
}

async function setCreditLimit(businessId, userId, id, creditLimit) {
  const customer = await Customer.findOne({ _id: id, businessId });
  if (!customer) throw ApiError.notFound('Customer not found');

  const oldLimit = customer.creditLimit;
  customer.creditLimit = creditLimit;
  await customer.save();

  await AuditLog.create({ businessId, userId, action: 'customer.credit_limit_change', entityType: 'Customer', entityId: customer._id, oldValue: { creditLimit: oldLimit }, newValue: { creditLimit } });
  return customer;
}

async function getLedger(businessId, customerId, { page, limit }) {
  await getCustomer(businessId, customerId); // 404s if not found/not this business

  const filter = { businessId, customerId };
  const [items, total] = await Promise.all([
    CustomerLedger.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    CustomerLedger.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

/**
 * recordCustomerPayment - the customer pays down their outstanding credit
 * balance outside of any specific sale (e.g. paying off last week's total).
 * Atomic: Payment record + CustomerLedger entry + Customer.outstandingBalance
 * update all succeed or fail together.
 */
async function recordCustomerPayment(businessId, branchId, userId, customerId, { method, amount, reference, shiftId }) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const customer = await Customer.findOne({ _id: customerId, businessId }).session(session);
      if (!customer) throw ApiError.notFound('Customer not found');
      if (amount > customer.outstandingBalance) {
        throw ApiError.badRequest('Payment exceeds the outstanding balance', 'OVERPAYMENT');
      }

      const [payment] = await Payment.create(
        [{ businessId, branchId, customerId, shiftId, method, provider: 'manual', amount, reference, initiatedBy: userId, status: 'SUCCESS', completedAt: new Date() }],
        { session }
      );

      const newBalance = customer.outstandingBalance - amount;
      await CustomerLedger.create(
        [{ businessId, customerId, transactionType: 'PAYMENT', referenceType: 'Payment', referenceId: payment._id, debit: 0, credit: amount, balance: newBalance, createdBy: userId }],
        { session }
      );
      await Customer.updateOne({ _id: customerId }, { $inc: { outstandingBalance: -amount } }, { session });

      await AuditLog.create(
        [{ businessId, branchId, userId, action: 'customer.payment', entityType: 'Customer', entityId: customer._id, newValue: { amount, method } }],
        { session }
      );

      result = { payment, newBalance };
    });
    return result;
  } finally {
    session.endSession();
  }
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, setCreditLimit, getLedger, recordCustomerPayment };
