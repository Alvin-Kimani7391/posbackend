/**
 * Account emails: password / PIN reset, owner welcome, employee welcome.
 * Every send is best-effort (sendEmail never throws) so a mail problem can never break sign-up or employee creation.
 */
const crypto = require('crypto');
const User = require('../models/User');
const { sendEmail } = require('./email.service');
const { renderEmail } = require('../utils/emailTemplates');

const first = (v) => String(v || '').split(',')[0].trim().replace(/\/+$/, '');

/** Public web-app address: VERIFY_BASE_URL, then APP_BASE_URL, then the first FRONTEND_URL ('' if unset or '*'). */
function appBase() {
  const env = require('../config/env');
  const base = first(env.verifyBaseUrl) || first(process.env.APP_BASE_URL) || first(env.frontendUrl);
  return base === '*' ? '' : base;
}

const prettyRole = (r) => String(r || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** One-time token (only its hash is stored). Returns the raw token for the link. */
async function issueResetToken(userId, minutes = 30) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  await User.updateOne({ _id: userId }, { $set: {
    passwordResetTokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
    passwordResetExpires: new Date(Date.now() + minutes * 60 * 1000),
  } });
  return rawToken;
}

function resetUrl(rawToken, kind) {
  const base = appBase();
  return base ? `${base}/reset-password.html?token=${encodeURIComponent(rawToken)}&kind=${kind === 'pin' ? 'pin' : 'password'}` : '';
}

async function sendResetEmail({ user, rawToken, kind, businessName }) {
  const link = resetUrl(rawToken, kind);
  if (!link) { console.warn('[auth] FRONTEND_URL / VERIFY_BASE_URL not set - reset email not sent'); return { ok: false, skipped: 'no_base_url' }; }
  const what = kind === 'pin' ? 'PIN' : 'password';
  const html = renderEmail({
    theme: 'indigo', icon: '\uD83D\uDD10', eyebrow: 'Account security', heading: `Reset your ${what}`,
    preheader: `Use this secure link to choose a new ${what}. It expires in 30 minutes.`,
    lead: `Choose a new ${what} and get back to work in seconds.`,
    greeting: `Hi ${user.name},`,
    paragraphs: [`We received a request to reset the ${what} for your Six Star POS account${businessName ? ` at ${businessName}` : ''}. Tap the button below to set a new one.`],
    rows: [['Account', user.email || ''], ['Link expires in', '30 minutes'], ['Can be used', 'Once']],
    cta: { label: `Set a new ${what}`, url: link },
    notice: { title: 'Didn\u2019t ask for this?', text: `You can safely ignore this email \u2014 your current ${what} will keep working. Never share this link with anyone.` },
    reason: 'You received this email because a reset was requested for your Six Star POS account.',
  });
  return sendEmail({
    to: [{ email: user.email, name: user.name }], subject: `Reset your Six Star POS ${what}`, html, tags: ['password-reset'],
    text: `Hi ${user.name}, set a new ${what}: ${link}\nThis link expires in 30 minutes and works once. If you did not ask for this, ignore this email.`,
  });
}

async function sendOwnerWelcome({ user, business }) {
  if (!user || !user.email) return { ok: false, skipped: 'no_email' };
  const base = appBase();
  const html = renderEmail({
    theme: 'teal', icon: '\uD83C\uDF89', eyebrow: 'Welcome aboard', heading: `Welcome to Six Star POS`,
    preheader: `${business.name} is ready. Here\u2019s how to start selling today.`,
    lead: `Your business account for ${business.name} is live and ready to sell.`,
    greeting: `Hi ${user.name},`,
    paragraphs: ['Thank you for choosing Six Star POS. Everything you need to run your shop \u2014 sales, stock, staff and reports \u2014 is now in one place.'],
    rows: [['Business', business.name], ['Owner', user.name], ['Sign in with', user.email || user.phone]],
    steps: [
      { title: 'Log in to your dashboard', text: 'Use your email or phone number and the password you created.' },
      { title: 'Add your products', text: 'Add items one by one or in bulk so you can start selling.' },
      { title: 'Invite your team', text: 'Add cashiers and managers \u2014 they get their own sign-in by email.' },
    ],
    cta: base ? { label: 'Open my dashboard', url: `${base}/login.html` } : null,
    notice: { tone: 'info', title: 'Keep your account safe', text: 'Never share your password. You can reset it any time from the login page using \u201cForgot password?\u201d.' },
    reason: 'You received this email because you created a Six Star POS account.',
  });
  return sendEmail({ to: [{ email: user.email, name: user.name }], subject: `Welcome to Six Star POS, ${user.name.split(' ')[0]}!`, html, tags: ['welcome', 'owner'] });
}

async function sendEmployeeWelcome({ user, business, addedBy, kind }) {
  if (!user || !user.email) return { ok: false, skipped: 'no_email' };
  const base = appBase();
  const hasCode = !!user.employeeCode && kind === 'pin';
  const loginUrl = base ? `${base}/login.html${hasCode ? `?tab=pin&businessId=${business._id}` : ''}` : '';
  let setupUrl = '';
  if (base) setupUrl = resetUrl(await issueResetToken(user._id, 72 * 60), kind);
  const what = kind === 'pin' ? 'PIN' : 'password';
  const rows = [['Business', business.name], ['Your role', prettyRole(user.role)]];
  if (hasCode) { rows.push(['Employee code', user.employeeCode]); rows.push(['Business ID', String(business._id)]); }
  else rows.push(['Sign in with', user.email]);
  const html = renderEmail({
    theme: 'teal', icon: '\uD83D\uDC4B', eyebrow: 'You\u2019ve been added', heading: `Welcome to ${business.name}`,
    preheader: `${addedBy || 'Your manager'} added you to ${business.name} on Six Star POS.`,
    lead: `${addedBy || 'Your manager'} has added you to the team.`,
    greeting: `Hi ${user.name},`,
    paragraphs: [`Your Six Star POS account is ready. Your sign-in details are below${hasCode ? ' \u2014 use your employee code and the PIN your manager gave you' : ''}.`],
    rows,
    steps: [
      { title: 'Open the login page', text: hasCode ? 'Choose the \u201cEmployee PIN\u201d tab. Your Business ID is filled in for you.' : 'Enter your email and password.' },
      { title: `Prefer your own ${what}?`, text: `Use the second button to choose one now. The link is valid for 3 days.` },
    ],
    cta: loginUrl ? { label: 'Log in to Six Star POS', url: loginUrl } : null,
    cta2: setupUrl ? { label: `Set my own ${what}`, url: setupUrl } : null,
    notice: { title: 'Keep it private', text: `Your ${what} is personal. Never share it, even with colleagues. Forgot it later? Use \u201cForgot ${what}?\u201d on the login page.` },
    reason: `You received this email because you were added as a team member of ${business.name} on Six Star POS.`,
  });
  return sendEmail({ to: [{ email: user.email, name: user.name }], subject: `You\u2019ve been added to ${business.name} on Six Star POS`, html, tags: ['welcome', 'employee'] });
}

module.exports = { appBase, issueResetToken, resetUrl, sendResetEmail, sendOwnerWelcome, sendEmployeeWelcome };
