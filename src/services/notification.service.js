const Notification = require('../models/Notification');
const User = require('../models/User');
const { ROLES } = require('../constants/roles');
const { TYPE_SEVERITY, EMPLOYEE_RAISABLE_TYPES } = require('../constants/notificationTypes');
const ApiError = require('../utils/ApiError');
const { toCents } = require('../utils/money');
const { getBusinessContext } = require('../utils/businessContext');
const { formatMoney } = require('../utils/currency');
const { t, methodLabel: i18nMethodLabel } = require('../i18n');

/**
 * Every amount in a notification is shown in the BUSINESS's own currency and language (KES/TZS, English/Swahili).
 * nctx.fmt(cents) prints the absolute amount (the sentence - "short by" / "over by" - says which way it goes).
 */
async function notifCtx(businessId) {
  const ctx = await getBusinessContext(businessId);
  const fmt = (cents) => formatMoney(cents, ctx.currency, { lang: ctx.language, abs: true });
  return { ...ctx, fmt, t: (key, params) => t(ctx.language, key, params) };
}

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
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  const base = {
    type: 'SHIFT_OPENED',
    branchId,
    sourceUserId: cashier._id,
    entityType: 'CashShift',
    entityId: shift._id,
    data: { registerId: shift.registerId?._id || shift.registerId, openingCash: shift.openingCash, openedAt: shift.openedAt, currency: nctx.currency },
  };

  return notifyActorAndManagement(
    businessId, cashier,
    {
      ...base,
      title: nctx.t('shift.opened.titleMgmt', { name: cashier.name }),
      message: nctx.t('shift.opened.msgMgmt', { name: cashier.name, register: shift.registerId?.code || '', amount: fmtMoney(shift.openingCash) }),
    },
    {
      ...base,
      title: nctx.t('shift.opened.titleOwn'),
      message: nctx.t('shift.opened.msgOwn', { register: shift.registerId?.code || '', amount: fmtMoney(shift.openingCash) }),
    }
  );
}

/**
 * notifyShiftClosed - short / over / balanced, sent BOTH to management and
 * to the cashier themselves, with the identical cash-sale breakdown in
 * `data.sales` AND the identical closing cash count in `data.denominations`
 * either way - the cashier gets exactly the same detail the owner does, not
 * a watered-down summary. Note: a discrepancy is a property of the WHOLE
 * drawer, not one sale - there's no way to say "sale X caused the shortage" -
 * so what's given instead is every cash sale in the shift plus the physical
 * count by note/coin, to cross-check against each other.
 *
 * data.denominations: [{ denomination (KES), count, subtotal (cents) }] - all
 * denominations, highest first (zero-count lines included so the UI can render
 * a fixed-shape table). The message text lists only the non-zero lines.
 */
async function notifyShiftClosed(businessId, branchId, shift, cashier, cashSales) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  const diff = shift.cashDifference;
  let type = 'SHIFT_CLOSED';
  let headline = nctx.t('shift.closed.headline.balanced');
  if (diff < 0) { type = 'CASH_SHORTAGE'; headline = nctx.t('shift.closed.headline.short', { amount: fmtMoney(diff) }); }
  else if (diff > 0) { type = 'CASH_OVER'; headline = nctx.t('shift.closed.headline.over', { amount: fmtMoney(diff) }); }

  const denominations = (shift.denominations || []).map((d) => ({
    denomination: d.denomination,
    count: d.count,
    subtotal: toCents(d.denomination * d.count),
  }));
  const denomLine = denominations
    .filter((d) => d.count > 0)
    .map((d) => `${d.count} × ${d.denomination.toLocaleString('en-US')}`)
    .join(', ');
  const denomText = denomLine ? nctx.t('shift.closed.counted', { lines: denomLine }) : '';

  const data = {
    openingCash: shift.openingCash,
    expectedCash: shift.expectedCash,
    actualCash: shift.actualCash,
    cashDifference: diff,
    currency: nctx.currency,
    denominations,
    denominationTotal: denominations.reduce((s, d) => s + d.subtotal, 0),
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

  let ownExtra = nctx.t('shift.closed.extraBalanced');
  if (diff < 0) ownExtra = nctx.t('shift.closed.extraShort');
  else if (diff > 0) ownExtra = nctx.t('shift.closed.extraOver');

  return notifyActorAndManagement(
    businessId, cashier,
    {
      ...base,
      title: nctx.t('shift.closed.titleMgmt', { name: cashier.name, headline }),
      message: nctx.t('shift.closed.msgMgmt', {
        name: cashier.name,
        register: shift.registerId?.code ? nctx.t('shift.closed.registerWord', { code: shift.registerId.code }) : '',
        opening: fmtMoney(shift.openingCash), expected: fmtMoney(shift.expectedCash), counted: fmtMoney(shift.actualCash),
        headline, denoms: denomText,
      }),
    },
    {
      ...base,
      title: nctx.t('shift.closed.titleOwn', { headline }),
      message: nctx.t('shift.closed.msgOwn', {
        opening: fmtMoney(shift.openingCash), expected: fmtMoney(shift.expectedCash), counted: fmtMoney(shift.actualCash),
        headline, denoms: denomText, extra: ownExtra,
      }),
    }
  );
}

/**
 * notifyShortagePayment - a manager/owner recorded a repayment against a
 * cashier's shortage. Goes to ALL management (so owner + other managers see
 * who took the money and how much is left) AND to the cashier themselves.
 * Uses type SHORTAGE_CLEARED when this payment brought the balance to zero,
 * SHORTAGE_PAYMENT otherwise. Amounts in `data` are integer cents, like every
 * other notification payload.
 *
 * The cashier is the RECIPIENT here, not the actor, so notifyActorAndManagement
 * (which keys off the actor) isn't used - we skip the cashier copy only if the
 * cashier is themselves management (they already got the management copy).
 */
async function notifyShortagePayment(businessId, shortage, cashier, actor, payment) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  const cleared = shortage.status === 'CLEARED';
  const type = cleared ? 'SHORTAGE_CLEARED' : 'SHORTAGE_PAYMENT';
  const cashierName = cashier?.name || nctx.t('shortage.theCashier');
  const actorName = actor?.name || nctx.t('shortage.aManager');
  const methodLabel = i18nMethodLabel(nctx.language, payment.method || 'CASH');
  const refText = payment.reference ? nctx.t('common.ref', { ref: payment.reference }) : '';

  const base = {
    type,
    branchId: shortage.branchId,
    sourceUserId: actor?._id,
    entityType: 'CashierShortage',
    entityId: shortage._id,
    data: {
      shortageId: shortage._id,
      shiftId: shortage.shiftId?._id || shortage.shiftId,
      cashierId: shortage.cashierId?._id || shortage.cashierId,
      cashierName,
      shortageAmount: shortage.amount,
      paymentAmount: payment.amount,
      totalPaid: shortage.amountPaid,
      balance: shortage.balance,
      method: payment.method,
      reference: payment.reference,
      status: shortage.status,
      recordedBy: actorName,
    },
  };

  const balanceLine = cleared
    ? nctx.t('shortage.cleared')
    : nctx.t('shortage.outstanding', { amount: fmtMoney(shortage.balance) });

  const managementPayload = {
    ...base,
    title: nctx.t(cleared ? 'shortage.titleClearedMgmt' : 'shortage.titlePaymentMgmt', { cashier: cashierName }),
    message: nctx.t('shortage.msgMgmt', { actor: actorName, amount: fmtMoney(payment.amount), method: methodLabel, cashier: cashierName, ref: refText, total: fmtMoney(shortage.amount), balanceLine }),
  };

  const results = await notifyManagement(businessId, managementPayload);

  if (cashier && !MANAGEMENT_ROLES.includes(cashier.role)) {
    const own = await notifyUser(businessId, cashier._id, {
      ...base,
      title: nctx.t(cleared ? 'shortage.titleClearedOwn' : 'shortage.titlePaymentOwn'),
      message: nctx.t('shortage.msgOwn', { actor: actorName, amount: fmtMoney(payment.amount), method: methodLabel, ref: refText, total: fmtMoney(shortage.amount), balanceLine }),
    });
    return [...results, own];
  }
  return results;
}

async function notifySaleCancelled(businessId, branchId, sale, cashier) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  return notifyManagement(businessId, {
    type: 'SALE_CANCELLED',
    title: nctx.t('sale.cancelledTitle', { receipt: sale.receiptNumber }),
    message: nctx.t('sale.cancelledMsg', { name: cashier?.name || nctx.t('sale.aCashier'), receipt: sale.receiptNumber, amount: fmtMoney(sale.total) }),
    branchId,
    sourceUserId: cashier?._id,
    entityType: 'Sale',
    entityId: sale._id,
    data: { receiptNumber: sale.receiptNumber, total: sale.total, reason: sale.cancelReason },
  });
}

async function notifyTransferRequested(businessId, transfer, requester) {
  const nctx = await notifCtx(businessId);
  return notifyManagement(businessId, {
    type: 'TRANSFER_REQUESTED',
    title: nctx.t('transfer.requestedTitle', { number: transfer.transferNumber }),
    message: nctx.t('transfer.requestedMsg', { name: requester?.name || nctx.t('transfer.aStaff'), number: transfer.transferNumber, count: transfer.items.length }),
    branchId: transfer.fromBranchId,
    sourceUserId: requester?._id,
    entityType: 'StockTransfer',
    entityId: transfer._id,
    data: { transferNumber: transfer.transferNumber, fromBranchId: transfer.fromBranchId, toBranchId: transfer.toBranchId, itemCount: transfer.items.length },
  });
}

// The owner can switch the in-app low-stock / out-of-stock notifications off (Alerts page). Cached for 30 s: this runs on stock changes.
const prefsCache = new Map();
async function stockAlertPrefs(businessId) {
  const key = String(businessId);
  const hit = prefsCache.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.v;
  const b = await require('../models/Business').findById(businessId).select('alertPrefs').lean();
  const v = { low: b?.alertPrefs?.lowStockNotify !== false, out: b?.alertPrefs?.outOfStockNotify !== false };
  prefsCache.set(key, { at: Date.now(), v });
  return v;
}
function forgetStockAlertPrefs(businessId) { prefsCache.delete(String(businessId)); }

async function notifyStockLevel(businessId, branchId, { productId, variantId, productName, quantity, threshold }) {
  const outOfStock = quantity <= 0;
  try {
    const prefs = await stockAlertPrefs(businessId);
    if (outOfStock ? !prefs.out : !prefs.low) return [];
  } catch (e) { /* never lose an alert because the preference could not be read */ }
  const nctx = await notifCtx(businessId);
  return notifyManagement(businessId, {
    type: outOfStock ? 'OUT_OF_STOCK' : 'LOW_STOCK',
    title: nctx.t(outOfStock ? 'stock.outTitle' : 'stock.lowTitle', { product: productName }),
    message: nctx.t(outOfStock ? 'stock.outMsg' : 'stock.lowMsg', { product: productName, quantity, threshold }),
    branchId,
    entityType: 'BranchInventory',
    entityId: productId,
    data: { productId, variantId, quantity, threshold },
  });
}

async function notifyRefundRequested(businessId, branchId, refund, sale, requester) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  return notifyManagement(businessId, {
    type: 'REFUND_REQUEST',
    title: nctx.t('refund.requestedTitle', { number: refund.refundNumber }),
    message: nctx.t('refund.requestedMsg', { name: requester?.name || nctx.t('refund.aStaff'), amount: fmtMoney(refund.amount), receipt: sale?.receiptNumber || '' }),
    branchId,
    sourceUserId: requester?._id,
    entityType: 'Refund',
    entityId: refund._id,
    data: { refundNumber: refund.refundNumber, amount: refund.amount, saleId: sale?._id, receiptNumber: sale?.receiptNumber, reason: refund.reason },
  });
}

async function notifyRefundCompleted(businessId, branchId, refund, sale, actor) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  return notifyManagement(businessId, {
    type: 'REFUND_COMPLETED',
    title: nctx.t('refund.completedTitle', { number: refund.refundNumber }),
    message: nctx.t('refund.completedMsg', { amount: fmtMoney(refund.amount), receipt: sale?.receiptNumber || '', by: actor?.name ? nctx.t('refund.by', { name: actor.name }) : '' }),
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
 * when some risk threshold is crossed. Sent via notifyActorAndManagement
 * so both sides get a detailed, personalized copy every single time.
 */
async function notifyCreditSaleIssued(businessId, branchId, customer, cashier, { amount, saleId, receiptNumber, newBalance, creditLimit, paymentStatus }) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  const availableCredit = Math.max((creditLimit || 0) - newBalance, 0);
  const modeLabel = nctx.t(paymentStatus === 'CREDIT' ? 'credit.fully' : 'credit.partly');

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
      title: nctx.t('credit.titleMgmt', { customer: customer.name }),
      message: nctx.t('credit.msgMgmt', { cashier: cashier.name, amount: fmtMoney(amount), customer: customer.name, mode: modeLabel, receipt: receiptNumber, balance: fmtMoney(newBalance), limit: fmtMoney(creditLimit), available: fmtMoney(availableCredit) }),
    },
    {
      ...base,
      title: nctx.t('credit.titleOwn', { customer: customer.name }),
      message: nctx.t('credit.msgOwn', { amount: fmtMoney(amount), customer: customer.name, mode: modeLabel, receipt: receiptNumber, balance: fmtMoney(newBalance), limit: fmtMoney(creditLimit), available: fmtMoney(availableCredit) }),
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
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
  const atOrOverLimit = outstandingBalance >= creditLimit;

  const managementPayload = {
    type: 'CREDIT_DUE',
    title: nctx.t(atOrOverLimit ? 'credit.dueTitleLimit' : 'credit.dueTitleNear', { customer: customer.name }),
    message: nctx.t(atOrOverLimit ? 'credit.dueMsgLimit' : 'credit.dueMsgNear', { customer: customer.name, balance: fmtMoney(outstandingBalance), limit: fmtMoney(creditLimit), percent: Math.round((outstandingBalance / creditLimit) * 100) }),
    entityType: 'Customer',
    entityId: customer._id,
    data: { customerId: customer._id, outstandingBalance, creditLimit, trigger, saleId, receiptNumber },
  };

  if (actor) {
    const actorPayload = {
      ...managementPayload,
      title: nctx.t(atOrOverLimit ? 'credit.dueOwnTitleLimit' : 'credit.dueOwnTitleNear', { customer: customer.name }),
      message: nctx.t(atOrOverLimit ? 'credit.dueOwnMsgLimit' : 'credit.dueOwnMsgNear', { customer: customer.name, balance: fmtMoney(outstandingBalance), limit: fmtMoney(creditLimit), percent: Math.round((outstandingBalance / creditLimit) * 100) }),
    };
    return notifyActorAndManagement(businessId, actor, managementPayload, actorPayload);
  }

  return notifyManagement(businessId, managementPayload);
}

/**
 * notifyCustomerPaymentReceived - fires every time someone records a
 * payment against a customer's outstanding credit balance (customer.service.js
 * recordCustomerPayment). Sent via notifyActorAndManagement so both the
 * cashier/owner who recorded the payment and the rest of management get a
 * detailed copy.
 */
async function notifyCustomerPaymentReceived(businessId, branchId, customer, actor, { amount, method, reference, newBalance }) {
  const nctx = await notifCtx(businessId);
  const fmtMoney = nctx.fmt;
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

  const methodWord = i18nMethodLabel(nctx.language, method);
  const refText = reference ? nctx.t('common.ref', { ref: reference }) : '';
  const balanceLine = newBalance > 0
    ? nctx.t('credit.stillOwes', { customer: customer.name, balance: fmtMoney(newBalance) })
    : nctx.t('credit.balanceCleared', { customer: customer.name });

  return notifyActorAndManagement(
    businessId, actor,
    {
      ...base,
      title: nctx.t('credit.payTitleMgmt', { customer: customer.name }),
      message: nctx.t('credit.payMsgMgmt', { actor: actor.name, amount: fmtMoney(amount), method: methodWord, customer: customer.name, ref: refText, balanceLine }),
    },
    {
      ...base,
      title: nctx.t('credit.payTitleOwn', { customer: customer.name }),
      message: nctx.t('credit.payMsgOwn', { amount: fmtMoney(amount), method: methodWord, customer: customer.name, ref: refText, balanceLine }),
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
  forgetStockAlertPrefs,
  notifyUser,
  notifyManagement,
  notifyActorAndManagement,
  notifyShiftOpened,
  notifyShiftClosed,
  notifyShortagePayment,
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