/**
 * Every owner/admin-facing billing message goes through here: in-app notification + Brevo email + a BillingEvent.
 * Everything is wrapped so a failure here can never break a payment or an invoice run.
 */
const Notification = require('../models/Notification');
const User = require('../models/User');
const Business = require('../models/Business');
const BillingEvent = require('../models/BillingEvent');
const { TYPE_SEVERITY } = require('../constants/notificationTypes');
const { ROLES } = require('../constants/roles');
const { sendEmail } = require('./email.service');
const { renderEmail, kes, fmtDate } = require('../utils/emailTemplates');
const settingsSvc = require('./billing.settings');

const APP = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const billingUrl = () => (APP() ? `${APP()}/billing.html` : null);
const adminUrl = (path) => (APP() ? `${APP()}/${path}` : null);

async function event(businessId, type, message, extra = {}) {
  try { await BillingEvent.create({ businessId: businessId || null, type, message, ...extra }); }
  catch (err) { console.error('[billing event] failed', err.message); }
}

async function contacts(businessId) {
  const [business, users] = await Promise.all([
    Business.findById(businessId).select('name email phone').lean(),
    User.find({ businessId, status: 'active', role: { $in: [ROLES.OWNER, ROLES.ADMIN] } }).select('name email role').lean(),
  ]);
  const emails = [...new Set([...users.filter((u) => u.role === ROLES.OWNER).map((u) => u.email), business?.email].filter(Boolean).map((e) => e.toLowerCase()))]
    .map((email) => ({ email }));
  return { business, users, emails };
}

async function notifyOwners({ businessId, type, title, message, data, entityType, entityId, severity, email, inApp = true, eventType }) {
  try {
    const { business, users, emails } = await contacts(businessId);
    if (inApp && users.length) {
      await Notification.insertMany(users.map((u) => ({
        businessId, userId: u._id, type, severity: severity || TYPE_SEVERITY[type] || 'info',
        title, message, data, entityType, entityId,
      })));
    }
    if (email) {
      const html = renderEmail({ greeting: `Hello ${business?.name || ''},`, ...email });
      const res = await sendEmail({ to: emails, subject: email.subject || title, html, tags: ['billing', type] });
      await event(businessId, res.ok ? 'EMAIL_SENT' : 'EMAIL_FAILED',
        `${res.ok ? 'Email sent' : `Email not sent (${res.skipped || res.error})`}: ${email.subject || title}`,
        { data: { type, recipients: emails.length } });
    }
    if (eventType) await event(businessId, eventType, title, { data });
  } catch (err) {
    console.error('[billing notify] failed', err.message);
  }
}

async function adminRecipients() {
  const s = await settingsSvc.get();
  const env = String(process.env.ADMIN_ALERT_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean);
  return [...new Set([...(s.alertEmails || []), ...env].map((e) => e.toLowerCase()))].map((email) => ({ email }));
}

/** Email to platform staff (the admin dashboard itself shows the queue / counters). */
async function adminAlert({ subject, heading, paragraphs, rows, ctaPath }) {
  try {
    const to = await adminRecipients();
    if (!to.length) return;
    const html = renderEmail({ heading: heading || subject, paragraphs, rows, cta: ctaPath && adminUrl(ctaPath) ? { label: 'Open admin dashboard', url: adminUrl(ctaPath) } : null });
    await sendEmail({ to, subject: `[Platform] ${subject}`, html, tags: ['billing', 'admin'] });
  } catch (err) { console.error('[billing admin alert] failed', err.message); }
}

const cta = () => (billingUrl() ? { label: 'Open billing page', url: billingUrl() } : null);

/* ----------------------------- specific events ----------------------------- */

async function invoiceIssued(inv) {
  const balance = inv.amount - inv.amountPaid;
  const covered = balance <= 0;
  await notifyOwners({
    businessId: inv.businessId, type: 'BILLING_INVOICE',
    title: covered ? `Invoice ${inv.number} paid from your credit` : `New invoice ${inv.number}`,
    message: covered
      ? `${inv.description} (${kes(inv.amount)}) was settled from your account credit.`
      : `${inv.description}: ${kes(balance)} due ${fmtDate(inv.dueDate)}.`,
    data: { invoiceNumber: inv.number, amount: inv.amount, balance, dueAt: inv.dueDate },
    entityType: 'Invoice', entityId: inv._id,
    email: {
      subject: covered ? `Invoice ${inv.number} - settled from credit` : `Invoice ${inv.number} - ${kes(balance)} due ${fmtDate(inv.dueDate)}`,
      heading: covered ? 'Invoice settled from your credit' : 'You have a new invoice',
      paragraphs: [inv.description],
      rows: [['Invoice', inv.number], ['Amount', kes(inv.amount)], ['Balance', kes(Math.max(balance, 0))], ['Due date', fmtDate(inv.dueDate)]],
      cta: covered ? null : cta(),
    },
    eventType: 'INVOICE_ISSUED',
  });
}

async function reminder(inv, key, ctx = {}) {
  const balance = inv.amount - inv.amountPaid;
  const overdue = (ctx.daysOverdue || 0) > 0 || (inv.dueDate <= new Date());
  let title; let lead;
  if (key === 'lock_warning') {
    title = `Account will be locked soon - ${inv.number}`;
    lead = `Your account will be locked on ${fmtDate(ctx.lockAt)} unless the overdue balance is paid. You will still be able to log in and pay.`;
  } else if (overdue) {
    title = `Payment overdue - ${inv.number}`;
    lead = `${kes(balance)} is overdue${ctx.daysOverdue ? ` by ${ctx.daysOverdue} day(s)` : ''}.${ctx.lockAt ? ` Your account will be locked on ${fmtDate(ctx.lockAt)} if it stays unpaid.` : ''}`;
  } else {
    title = `Payment due ${fmtDate(inv.dueDate)} - ${inv.number}`;
    lead = `${kes(balance)} falls due on ${fmtDate(inv.dueDate)}.`;
  }
  await notifyOwners({
    businessId: inv.businessId, type: 'BILLING_DUE', severity: overdue ? 'critical' : 'warning',
    title, message: `${inv.description}. ${lead}`,
    data: { invoiceNumber: inv.number, balance, dueAt: inv.dueDate, lockAt: ctx.lockAt || undefined },
    entityType: 'Invoice', entityId: inv._id,
    email: {
      subject: title, heading: overdue ? 'Payment overdue' : 'Payment reminder',
      paragraphs: [lead, 'Pay with M-PESA from the billing page. Part-payments are accepted and carry forward.'],
      rows: [['Invoice', inv.number], ['Description', inv.description], ['Balance', kes(balance)], ['Due date', fmtDate(inv.dueDate)]],
      cta: cta(),
    },
    eventType: 'REMINDER_SENT',
  });
}

async function paymentReceived(p) {
  const lines = (p.allocations || []).map((a) => `${a.invoiceNumber}: ${kes(a.amount)}`);
  await notifyOwners({
    businessId: p.businessId, type: 'BILLING_PAYMENT',
    title: `Payment received - ${kes(p.amount)}`,
    message: `Thank you. ${kes(p.amount)} was applied to your account${p.creditAddedCents ? ` (${kes(p.creditAddedCents)} kept as credit for upcoming invoices)` : ''}.`,
    data: { amount: p.amount, reference: p.reference, receiptCode: p.mpesaReceiptNumber || undefined },
    entityType: 'SubscriptionPayment', entityId: p._id,
    email: {
      subject: `Payment received - ${kes(p.amount)}`, heading: 'Payment received',
      paragraphs: ['Thank you - your payment has been applied.', ...lines],
      rows: [['Amount', kes(p.amount)], ['Reference', p.reference], ...(p.mpesaReceiptNumber ? [['M-PESA code', p.mpesaReceiptNumber]] : []), ...(p.creditAddedCents ? [['Credit carried forward', kes(p.creditAddedCents)]] : [])],
      cta: cta(),
    },
    eventType: 'PAYMENT_SUCCESS',
  });
}

async function manualSubmitted(p, businessName) {
  await notifyOwners({
    businessId: p.businessId, type: 'BILLING_PAYMENT',
    title: 'Payment submitted for verification',
    message: `We received your M-PESA message (${p.mpesaReceiptNumber || p.reference}). It will be credited once verified, usually within a few hours.`,
    entityType: 'SubscriptionPayment', entityId: p._id, eventType: 'MANUAL_SUBMITTED',
  });
  await adminAlert({
    subject: `Manual payment to verify - ${businessName || 'a business'}`,
    paragraphs: [`${businessName || 'A business'} submitted an M-PESA payment of ${kes(p.claimedAmount)} (code ${p.mpesaReceiptNumber}).`, ...(p.flags?.length ? [`Flags: ${p.flags.join(', ')}`] : [])],
    ctaPath: 'admin-billing.html',
  });
}

async function manualRejected(p, reason) {
  await notifyOwners({
    businessId: p.businessId, type: 'BILLING_PAYMENT', severity: 'warning',
    title: 'Payment could not be verified',
    message: `Your submitted payment (${p.mpesaReceiptNumber || p.reference}) was not approved. Reason: ${reason}`,
    entityType: 'SubscriptionPayment', entityId: p._id,
    email: { subject: 'Payment could not be verified', heading: 'Payment not approved', paragraphs: [`Your submitted payment (${p.mpesaReceiptNumber || p.reference}) was not approved.`, `Reason: ${reason}`, 'If you believe this is a mistake, contact support or submit the correct M-PESA message.'], cta: cta() },
    eventType: 'MANUAL_REJECTED',
  });
}

async function locked(sub, { auto, note }) {
  await notifyOwners({
    businessId: sub.businessId, type: 'BILLING_LOCKED', severity: 'critical',
    title: 'Account locked - payment required',
    message: `${auto ? `Your account was locked because of an overdue balance of ${kes(sub.arrearsCents)}.` : `Your account was locked by the administrator${note ? `: ${note}` : '.'}`} Open the Billing page to pay - it is still available to you.`,
    data: { balance: sub.arrearsCents },
    email: { subject: 'Your account is locked - payment required', heading: 'Account locked', paragraphs: [auto ? `Your account has been locked because ${kes(sub.arrearsCents)} is overdue.` : `Your account has been locked by the administrator${note ? `: ${note}` : '.'}`, 'Once the balance is paid, access is restored automatically.'], cta: cta() },
    eventType: 'LOCKED',
  });
  if (auto) await adminAlert({ subject: 'Business auto-locked for non-payment', paragraphs: [`Business ${sub.businessId} was locked. Arrears: ${kes(sub.arrearsCents)}.`], ctaPath: 'admin-billing.html' });
}

async function restored(sub) {
  await notifyOwners({
    businessId: sub.businessId, type: 'BILLING_RESTORED',
    title: 'Account restored', message: 'Thank you - your account is active again.',
    email: { subject: 'Your account is active again', heading: 'Account restored', paragraphs: ['Your balance is cleared and full access has been restored. Thank you.'], cta: cta() },
    eventType: 'UNLOCKED',
  });
}

async function trialEnding(sub, daysLeft) {
  await notifyOwners({
    businessId: sub.businessId, type: 'BILLING_TRIAL',
    title: `Free trial ends in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
    message: `Your trial ends on ${fmtDate(sub.phaseEndsAt)}. Your first invoice will be issued then.`,
    email: { subject: `Your free trial ends in ${daysLeft} day(s)`, heading: 'Your free trial is ending', paragraphs: [`Your free trial ends on ${fmtDate(sub.phaseEndsAt)}. Your first invoice will be issued then so you can keep using Six Star POS without interruption.`], cta: cta() },
    eventType: 'TRIAL_ENDING',
  });
}

async function trialEnded(sub) {
  await event(sub.businessId, 'TRIAL_ENDED', 'Free trial ended', { subscriptionId: sub._id });
}

/** Admin-written custom alert to a business (in-app + email). */
async function custom({ businessId, title, message, severity, sendEmailToo = true, actor }) {
  await notifyOwners({
    businessId, type: 'BILLING_NOTICE', severity: severity || 'warning', title, message,
    email: sendEmailToo ? { subject: title, heading: title, paragraphs: [message], cta: cta() } : null,
    eventType: 'ADMIN_NOTICE',
  });
  await event(businessId, 'ADMIN_NOTICE_SENT', `Notice sent: ${title}`, { actorId: actor?._id, actorName: actor?.name });
}

module.exports = { event, notifyOwners, adminAlert, invoiceIssued, reminder, paymentReceived, manualSubmitted, manualRejected, locked, restored, trialEnding, trialEnded, custom };