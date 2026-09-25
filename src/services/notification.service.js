const Notification = require('../models/Notification');
const User = require('../models/User');
const { ROLES } = require('../constants/roles');
const { TYPE_SEVERITY, EMPLOYEE_RAISABLE_TYPES } = require('../constants/notificationTypes');
const ApiError = require('../utils/ApiError');

const formatKES = (cents) =>
  `KES ${(Math.abs(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const MANAGEMENT_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER];

/** Creates one notification for a specific user. */
async function notifyUser(businessId, userId, { type, title, message, data, branchId, sourceUserId, entityType, entityId, severity }) {
  return Notification.create({
    businessId, userId, type, title, message, data, branchId, sourceUserId, entityType, entityId,
    severity: severity || TYPE_SEVERITY[type] || 'info',
  });
}

/**
 * notifyManagement - fans a notification out to every active OWNER/ADMIN/
 * MANAGER on the business. This is the single choke point every event
 * hook below goes through, which is what makes "admin sees everything
 * happening in the system" true without each hook re-implementing the
 * recipient lookup.
 */
async function notifyManagement(businessId, { type, title, message, data, branchId, sourceUserId, entityType, entityId, severity }) {
  const recipients = await User.find({
    businessId,
    status: 'active',
    role: { $in: MANAGEMENT_ROLES },
  }).select('_id');

  if (!recipients.length) return [];

  const base = {
    businessId, branchId, type, title, message, data, sourceUserId, entityType, entityId,
    severity: severity || TYPE_SEVERITY[type] || 'info',
  };

  return Notification.insertMany(recipients.map((u) => ({ ...base, userId: u._id })));
}

/**
 * notifyActorAndManagement - sends the management-facing notification via
 * notifyManagement as before, AND a personalized copy to the actor
 * themselves (e.g. the cashier who opened/closed the shift, or who issued
 * a credit sale), so staff get the same transparency owners do.
 *
 * Skips the actor's own copy if they're already OWNER/ADMIN/MANAGER -
 * notifyManagement already reached them in that case, and a second,
 * differently-worded notification for the same event would just be noise.
 */
async function notifyActorAndManagement(businessId, actor, managementPayload, actorPayload) {
  const results = await notifyManagement(businessId, managementPayload);
  if (!MANAGEMENT_ROLES.includes(actor.role)) {
    const own = await notifyUser(businessId, actor._id, actorPayload);
    return [...results, own];
  }
  return results;
}

/* -------------------------------------------------------------------- */
/* Event-specific builders - one per thing that happens in the system.  */
/* Title/message/data formatting for a given event lives in exactly one */
/* place instead of being duplicated at every call site.                */
/* -------------------------------------------------------------------- */

async function notifyShiftOpened(businessId, branchId, shift, cashier) {
  const base = {
    type: 'SHIFT_OPENED',
    branchId,
    sourceUserId: cashier._id,
    entityType: 'CashShift',
    entityId: shift._id,
    data: { registerId: shift.registerId?._id || shift.registerId, openingCash: shift.openingCash, openedAt: shift.openedAt },
  };

  return notifyActorAndManagement(
    businessId, cashier,
    {
      ...base,
      title: `Shift opened - ${cashier.name}`,
      message: `${cashier.name} opened register ${shift.registerId?.code || ''} with a float of ${formatKES(shift.openingCash)}.`,
    },
    {
      ...base,
      title: 'Shift opened',
      message: `You opened register ${shift.registerId?.code || ''} with a float of ${formatKES(shift.openingCash)}. Every cash sale you ring up adds to what's expected in the drawer when you close.`,
    }
  );
}

/**
 * notifyShiftClosed - short / over / balanced, sent BOTH to management and
 * to the cashier themselves, with the identical cash-sale breakdown in
 * `data.sales` either way - the cashier gets exactly the same receipt-level
 * detail the owner does, not a watered-down summary. Note: a discrepancy is
 * a property of the WHOLE drawer, not one sale - there's no way to say
 * "sale X caused the shortage" - so what's given instead is every cash sale
 * in the shift, to cross-check against what was physically counted.
 */
async function notifyShiftClosed(businessId, branchId, shift, cashier, cashSales) {
  const diff = shift.cashDifference;
  let type = 'SHIFT_CLOSED';
  let headline = 'balanced';
  if (diff < 0) { type = 'CASH_SHORTAGE'; headline = `short by ${formatKES(diff)}`; }
  else if (diff > 0) { type = 'CASH_OVER'; headline = `over by ${formatKES(diff)}`; }

  const data = {
    openingCash: shift.openingCash,
    expectedCash: shift.expectedCash,
    actualCash: shift.actualCash,
    cashDifference: diff,
    cashSaleCount: cashSales.length,
    sales: cashSales.map((p) => ({
      saleId: p.saleId,
      receiptNumber: p.receiptNumber,
      amount: p.amount,
      amountTendered: p.amountTendered,
      changeGiven: p.changeGiven,
      at: p.createdAt,
    })),
    notes: shift.notes,
  };

  const base = { type, branchId, sourceUserId: cashier._id, entityType: 'CashShift', entityId: shift._id, data };

  let ownExtra = ' Nicely balanced.';
  if (diff < 0) ownExtra = " Check the cash sales below against what you counted, and flag your manager if you can't account for the difference.";
  else if (diff > 0) ownExtra = ' Check the cash sales below, and hand the extra over to your manager.';

  return notifyActorAndManagement(
    businessId, cashier,
    {
      ...base,
      title: `Shift closed - ${cashier.name} (${headline})`,
      message:
        `${cashier.name} closed register${shift.registerId?.code ? ` ${shift.registerId.code}` : ''}. ` +
        `Opening float ${formatKES(shift.openingCash)}, expected ${formatKES(shift.expectedCash)}, ` +
        `counted ${formatKES(shift.actualCash)} - drawer is ${headline}.`,
    },
    {
      ...base,
      title: `Shift closed (${headline})`,
      message:
        `Your shift is closed. Opening float ${formatKES(shift.openingCash)}, expected ${formatKES(shift.expectedCash)} ` +
        `from cash sales, you counted ${formatKES(shift.actualCash)} - drawer is ${headline}.${ownExtra}`,
    }
  );
}

async function notifySaleCancelled(businessId, branchId, sale, cashier) {
  return notifyManagement(businessId, {
    type: 'SALE_CANCELLED',
    title: `Sale cancelled - ${sale.receiptNumber}`,
    message: `${cashier?.name || 'A cashier'} cancelled sale ${sale.receiptNumber} (${formatKES(sale.total)}).`,
    branchId,
    sourceUserId: cashier?._id,
    entityType: 'Sale',
    entityId: sale._id,
    data: { receiptNumber: sale.receiptNumber, total: sale.total, reason: sale.cancelReason },
  });
}

async function notifyTransferRequested(businessId, transfer, requester) {
  return notifyManagement(businessId, {
    type: 'TRANSFER_REQUESTED',
    title: `Transfer requested - ${transfer.transferNumber}`,
    message: `${requester?.name || 'A staff member'} requested transfer ${transfer.transferNumber} (${transfer.items.length} item(s)), awaiting approval.`,
    branchId: transfer.fromBranchId,
    sourceUserId: requester?._id,
    entityType: 'StockTransfer',
    entityId: transfer._id,
    data: { transferNumber: transfer.transferNumber, fromBranchId: transfer.fromBranchId, toBranchId: transfer.toBranchId, itemCount: transfer.items.length },
  });
}

async function notifyStockLevel(businessId, branchId, { productId, variantId, productName, quantity, threshold }) {
  const outOfStock = quantity <= 0;
  return notifyManagement(businessId, {
    type: outOfStock ? 'OUT_OF_STOCK' : 'LOW_STOCK',
    title: outOfStock ? `Out of stock - ${productName}` : `Low stock - ${productName}`,
    message: outOfStock
      ? `${productName} just ran out of stock.`
      : `${productName} is down to ${quantity} unit(s) (threshold: ${threshold}).`,
    branchId,
    entityType: 'BranchInventory',
    entityId: productId,
    data: { productId, variantId, quantity, threshold },
  });
}

async function notifyRefundRequested(businessId, branchId, refund, sale, requester) {
  return notifyManagement(businessId, {
    type: 'REFUND_REQUEST',
    title: `Refund requested - ${refund.refundNumber}`,
    message: `${requester?.name || 'A staff member'} requested a ${formatKES(refund.amount)} refund on sale ${sale?.receiptNumber || ''} - awaiting approval.`,
    branchId,
    sourceUserId: requester?._id,
    entityType: 'Refund',
    entityId: refund._id,
    data: { refundNumber: refund.refundNumber, amount: refund.amount, saleId: sale?._id, receiptNumber: sale?.receiptNumber, reason: refund.reason },
  });
}

async function notifyRefundCompleted(businessId, branchId, refund, sale, actor) {
  return notifyManagement(businessId, {
    type: 'REFUND_COMPLETED',
    title: `Refund completed - ${refund.refundNumber}`,
    message: `${formatKES(refund.amount)} refunded on sale ${sale?.receiptNumber || ''}${actor?.name ? ` by ${actor.name}` : ''}.`,
    branchId,
    sourceUserId: actor?._id,
    entityType: 'Refund',
    entityId: refund._id,
    data: { refundNumber: refund.refundNumber, amount: refund.amount, saleId: sale?._id, receiptNumber: sale?.receiptNumber },
  });
}

/**
 * notifyCreditSaleIssued - fires on EVERY sale that leaves a balance on a
 * customer's account (whether fully on credit or partially paid), not just
 * when some risk threshold is crossed. This is the notification that was
 * previously MISSING entirely: neither the owner nor the cashier who
 * granted the credit ever heard about the sale itself unless it happened
 * to cross the warning line in notifyCreditDue below - and even then only
 * management was told, never the cashier. Sent via notifyActorAndManagement
 * so both sides get a detailed, personalized copy every single time.
 */
async function notifyCreditSaleIssued(businessId, branchId, customer, cashier, { amount, saleId, receiptNumber, newBalance, creditLimit, paymentStatus }) {
  const availableCredit = Math.max((creditLimit || 0) - newBalance, 0);
  const modeLabel = paymentStatus === 'CREDIT' ? 'fully on credit' : 'partially on credit';

  const base = {
    type: 'CREDIT_SALE',
    branchId,
    sourceUserId: cashier._id,
    entityType: 'Sale',
    entityId: saleId,
    data: {
      customerId: customer._id,
      customerName: customer.name,
      amount,
      newBalance,
      creditLimit,
      availableCredit,
      saleId,
      receiptNumber,
      paymentStatus,
    },
  };

  return notifyActorAndManagement(
    businessId, cashier,
    {
      ...base,
      title: `Credit sale - ${customer.name}`,
      message:
        `${cashier.name} sold ${formatKES(amount)} to ${customer.name} ${modeLabel} (receipt ${receiptNumber}). ` +
        `${customer.name} now owes ${formatKES(newBalance)} of a ${formatKES(creditLimit)} limit (${formatKES(availableCredit)} still available).`,
    },
    {
      ...base,
      title: `You issued credit - ${customer.name}`,
      message:
        `You sold ${formatKES(amount)} to ${customer.name} ${modeLabel} (receipt ${receiptNumber}). ` +
        `They now owe ${formatKES(newBalance)} of a ${formatKES(creditLimit)} limit (${formatKES(availableCredit)} still available).`,
    }
  );
}

/**
 * notifyCreditDue - the RISK-level warning: fires only the moment a
 * customer's total balance crosses the warning threshold (or when a
 * lowered credit limit retroactively puts them over it). Distinct from
 * notifyCreditSaleIssued above, which reports on the sale itself every
 * time. When `actor` is supplied (the cashier whose sale caused the
 * crossing), the cashier gets a copy too - not just management. When
 * there's no natural actor (e.g. an owner lowering a credit limit),
 * management-only is correct, since the actor there IS management.
 */
async function notifyCreditDue(businessId, customer, { outstandingBalance, creditLimit, trigger, saleId, receiptNumber, actor }) {
  const atOrOverLimit = outstandingBalance >= creditLimit;

  const managementPayload = {
    type: 'CREDIT_DUE',
    title: atOrOverLimit ? `Credit limit reached - ${customer.name}` : `Nearing credit limit - ${customer.name}`,
    message: atOrOverLimit
      ? `${customer.name} now owes ${formatKES(outstandingBalance)}, at or over their ${formatKES(creditLimit)} limit.`
      : `${customer.name} owes ${formatKES(outstandingBalance)} of a ${formatKES(creditLimit)} limit (${Math.round((outstandingBalance / creditLimit) * 100)}%).`,
    entityType: 'Customer',
    entityId: customer._id,
    data: { customerId: customer._id, outstandingBalance, creditLimit, trigger, saleId, receiptNumber },
  };

  if (actor) {
    const actorPayload = {
      ...managementPayload,
      title: atOrOverLimit ? `${customer.name} hit their credit limit` : `${customer.name} is nearing their credit limit`,
      message: atOrOverLimit
        ? `Heads up: after your sale, ${customer.name} now owes ${formatKES(outstandingBalance)}, at or over the ${formatKES(creditLimit)} limit set for them.`
        : `Heads up: after your sale, ${customer.name} owes ${formatKES(outstandingBalance)} of their ${formatKES(creditLimit)} limit (${Math.round((outstandingBalance / creditLimit) * 100)}%).`,
    };
    return notifyActorAndManagement(businessId, actor, managementPayload, actorPayload);
  }

  return notifyManagement(businessId, managementPayload);
}




/**
 * notifyCustomerPaymentReceived - fires every time someone records a
 * payment against a customer's outstanding credit balance (customer.service.js
 * recordCustomerPayment). This was previously MISSING entirely - unlike a
 * credit sale being issued, paying a balance down never told anyone it
 * happened. Sent via notifyActorAndManagement so both the cashier/owner who
 * recorded the payment and the rest of management get a detailed copy.
 */
async function notifyCustomerPaymentReceived(businessId, branchId, customer, actor, { amount, method, reference, newBalance }) {
  const base = {
    type: 'CUSTOMER_PAYMENT',
    branchId,
    sourceUserId: actor._id,
    entityType: 'Customer',
    entityId: customer._id,
    data: {
      customerId: customer._id,
      customerName: customer.name,
      amount,
      method,
      reference,
      newBalance,
    },
  };

  const balanceLine = newBalance > 0
    ? `${customer.name} still owes ${formatKES(newBalance)}.`
    : `${customer.name}'s balance is now fully cleared.`;

  return notifyActorAndManagement(
    businessId, actor,
    {
      ...base,
      title: `Payment received - ${customer.name}`,
      message: `${actor.name} recorded a ${formatKES(amount)} ${method} payment from ${customer.name}${reference ? ` (ref: ${reference})` : ''}. ${balanceLine}`,
    },
    {
      ...base,
      title: `You recorded a payment - ${customer.name}`,
      message: `You recorded a ${formatKES(amount)} ${method} payment from ${customer.name}${reference ? ` (ref: ${reference})` : ''}. ${balanceLine}`,
    }
  );
}
/**
 * notifyEmployeeAlert - "employee chooses to notify the owner" path. Any
 * staff member can raise one of EMPLOYEE_RAISABLE_TYPES with a free-text
 * message, without waiting for an automatic hook to catch it.
 */
async function notifyEmployeeAlert(businessId, branchId, sender, { type, message, data }) {
  if (!EMPLOYEE_RAISABLE_TYPES.includes(type)) {
    throw ApiError.badRequest(`"${type}" cannot be raised manually`, 'INVALID_NOTIFICATION_TYPE');
  }
  return notifyManagement(businessId, {
    type,
    title: `${sender.name} flagged: ${type.replace(/_/g, ' ').toLowerCase()}`,
    message,
    branchId,
    sourceUserId: sender._id,
    entityType: 'EmployeeAlert',
    data,
  });
}

async function listForUser(businessId, userId, { unreadOnly, type, page, limit }) {
  const filter = { businessId, userId };
  if (unreadOnly) filter.readAt = null;
  if (type) filter.type = type;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ businessId, userId, readAt: null }),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1, unreadCount };
}

async function markRead(businessId, userId, id) {
  const notification = await Notification.findOneAndUpdate({ _id: id, businessId, userId }, { readAt: new Date() }, { new: true });
  if (!notification) throw ApiError.notFound('Notification not found');
  return notification;
}

async function markAllRead(businessId, userId) {
  const result = await Notification.updateMany({ businessId, userId, readAt: null }, { readAt: new Date() });
  return { updated: result.modifiedCount };
}

async function remove(businessId, userId, id) {
  const notification = await Notification.findOneAndDelete({ _id: id, businessId, userId });
  if (!notification) throw ApiError.notFound('Notification not found');
  return notification;
}

module.exports = {
  notifyUser,
  notifyManagement,
  notifyActorAndManagement,
  notifyShiftOpened,
  notifyShiftClosed,
  notifySaleCancelled,
  notifyTransferRequested,
  notifyStockLevel,
  notifyRefundRequested,
  notifyRefundCompleted,
  notifyCreditSaleIssued,
  notifyCreditDue,
  notifyCustomerPaymentReceived,
  notifyEmployeeAlert,
  listForUser,
  markRead,
  markAllRead,
  remove,
};