const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const CustomerLedger = require('../models/CustomerLedger');
const Payment = require('../models/Payment');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const notificationService = require('./notification.service');

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

  // A lowered limit can retroactively put an existing balance at/over the
  // new ceiling - worth flagging immediately rather than waiting for the
  // next credit sale to notice.
  if (creditLimit > 0 && customer.outstandingBalance >= creditLimit) {
    notificationService.notifyCreditDue(businessId, customer, {
      outstandingBalance: customer.outstandingBalance, creditLimit, trigger: 'credit_limit_lowered',
    }).catch((err) => console.error('notifyCreditDue failed', err));
  }

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
 *
 * Notification fires AFTER the transaction commits (same pattern as
 * refund.service.js#completeRefund and sale.service.js#cancelSale) - a
 * User lookup is needed here because this function only receives userId,
 * not a full user object with .name/.role the way sale.service.js's
 * cashierUser already has.
 */
async function recordCustomerPayment(businessId, branchId, userId, customerId, { method, amount, reference, shiftId }) {
  const session = await mongoose.startSession();
  let result;
  try {
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

      result = { payment, newBalance, customer };
    });
  } finally {
    session.endSession();
  }

  // Fire-and-forget notification, same non-blocking pattern used
  // throughout sale.service.js / refund.service.js - a slow/failed
  // notification should never fail an already-committed payment.
  const actor = await User.findById(userId).select('name role');
  if (actor) {
    notificationService.notifyCustomerPaymentReceived(businessId, branchId, result.customer, actor, {
      amount: result.payment.amount, method: result.payment.method, reference: result.payment.reference, newBalance: result.newBalance,
    }).catch((err) => console.error('notifyCustomerPaymentReceived failed', err));
  }

  return { payment: result.payment, newBalance: result.newBalance };
}

module.exports = { listCustomers, getCustomer, createCustomer, updateCustomer, setCreditLimit, getLedger, recordCustomerPayment };