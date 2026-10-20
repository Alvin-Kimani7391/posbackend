/** Guest accounts for the QR page. Tokens are separate from staff tokens and only work on /public/qr. */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const GuestAccount = require('../../models/GuestAccount');
const GuestReceipt = require('../../models/GuestReceipt');
const GuestRequest = require('../../models/GuestRequest');
const MpesaTransaction = require('../../models/MpesaTransaction');
const ApiError = require('../../utils/ApiError');
const qr = require('./qr.service');

const secret = () => `${require('../../config/env').jwt.secret}:guest-account`;
const sign = (a) => jwt.sign({ gid: String(a._id), bid: String(a.businessId) }, secret(), { expiresIn: '60d' });
const digits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('254')) d = d.slice(3); if (d.startsWith('0')) d = d.slice(1); return /^[17]\d{8}$/.test(d) ? `254${d}` : null; };
const view = (a) => ({ createdAt: a.createdAt, id: a._id, name: a.name, email: a.email, phone: a.phone ? `0${a.phone.slice(3)}` : undefined, picture: a.picture, google: !!a.googleSub });
const out = (a) => ({ token: sign(a), account: view(a) });

/** Reads the optional "Authorization: Bearer" header. Returns the account or null; never throws for a missing/bad token. */
async function fromRequest(req, businessId) {
  const h = req.headers.authorization || ''; if (!h.startsWith('Bearer ')) return null;
  try {
    const p = jwt.verify(h.slice(7), secret()); if (String(p.bid) !== String(businessId)) return null;
    return await GuestAccount.findOne({ _id: p.gid, businessId });
  } catch (e) { return null; }
}
async function need(req, businessId) { const a = await fromRequest(req, businessId); if (!a) throw ApiError.unauthorized('Please sign in to continue', 'GUEST_AUTH_REQUIRED'); return a; }

async function register(token, { name, email, phone, password }) {
  const { doc } = await qr.resolve(token); const businessId = doc.businessId;
  const ph = phone ? digits(phone) : null; if (phone && !ph) throw ApiError.badRequest('Enter a valid Kenyan phone number', 'INVALID_PHONE');
  if (!email && !ph) throw ApiError.badRequest('Add an email or a phone number', 'CONTACT_REQUIRED');
  try {
    const a = await GuestAccount.create({ businessId, name, email: email || undefined, phone: ph || undefined, passwordHash: await bcrypt.hash(password, 10), lastLoginAt: new Date() });
    return out(a);
  } catch (e) { if (e.code === 11000) throw ApiError.conflict('You already have an account. Please sign in.', 'ACCOUNT_EXISTS'); throw e; }
}
async function login(token, { identifier, password }) {
  const { doc } = await qr.resolve(token); const businessId = doc.businessId; const id = String(identifier || '').trim().toLowerCase();
  const ph = digits(id);
  const a = await GuestAccount.findOne({ businessId, $or: [{ email: id }, ...(ph ? [{ phone: ph }] : [])] }).select('+passwordHash');
  const bad = () => ApiError.unauthorized('Wrong email, phone or password', 'INVALID_LOGIN');
  if (!a || !a.passwordHash) { if (a && a.googleSub) throw ApiError.badRequest('This account uses Google. Tap "Continue with Google".', 'USE_GOOGLE'); throw bad(); }
  if (!(await bcrypt.compare(String(password || ''), a.passwordHash))) throw bad();
  a.lastLoginAt = new Date(); await a.save(); return out(a);
}
async function google(token, { credential }) {
  const { doc } = await qr.resolve(token); const businessId = doc.businessId; const cid = process.env.GOOGLE_CLIENT_ID;
  if (!cid) throw ApiError.badRequest('Google sign-in is not set up here', 'GOOGLE_DISABLED');
  let g; try { g = (await axios.get('https://oauth2.googleapis.com/tokeninfo', { params: { id_token: credential }, timeout: 8000 })).data; } catch (e) { throw ApiError.unauthorized('Google sign-in failed. Please try again.', 'GOOGLE_FAILED'); }
  if (g.aud !== cid || !(g.email_verified === true || g.email_verified === 'true')) throw ApiError.unauthorized('Google sign-in failed. Please try again.', 'GOOGLE_FAILED');
  const email = String(g.email).toLowerCase();
  let a = await GuestAccount.findOne({ businessId, $or: [{ googleSub: g.sub }, { email }] });
  if (!a) a = await GuestAccount.create({ businessId, name: g.name || email.split('@')[0], email, googleSub: g.sub, picture: g.picture, lastLoginAt: new Date() });
  else { if (!a.googleSub) a.googleSub = g.sub; if (!a.picture && g.picture) a.picture = g.picture; a.lastLoginAt = new Date(); await a.save(); }
  return out(a);
}
/** The guest edits their own details: name, phone, email (not for Google accounts) and, optionally, the password. */
async function updateProfile(token, req, { name, phone, email, currentPassword, newPassword }) {
  const { doc } = await qr.resolve(token); const a0 = await need(req, doc.businessId);
  const a = await GuestAccount.findById(a0._id).select('+passwordHash');
  if (name !== undefined) { if (String(name).trim().length < 2) throw ApiError.badRequest('Please enter your name', 'NAME_REQUIRED'); a.name = String(name).trim(); }
  if (phone !== undefined) { if (phone === '') a.phone = undefined; else { const ph = digits(phone); if (!ph) throw ApiError.badRequest('Enter a valid Kenyan phone number', 'INVALID_PHONE'); a.phone = ph; } }
  if (email !== undefined) {
    const em = String(email).trim().toLowerCase();
    if (a.googleSub && em !== (a.email || '')) throw ApiError.badRequest('Your email comes from Google and cannot be changed here', 'EMAIL_LOCKED');
    a.email = em || undefined;
  }
  if (!a.email && !a.phone) throw ApiError.badRequest('Keep at least an email or a phone number', 'CONTACT_REQUIRED');
  if (newPassword) {
    if (a.passwordHash && !(await bcrypt.compare(String(currentPassword || ''), a.passwordHash))) throw ApiError.badRequest('Your current password is not right', 'WRONG_PASSWORD');
    a.passwordHash = await bcrypt.hash(newPassword, 10);
  }
  try { await a.save(); } catch (e) { if (e.code === 11000) throw ApiError.conflict('That phone number or email is already used by another account', 'CONTACT_TAKEN'); throw e; }
  return { account: { ...view(a), createdAt: a.createdAt } };
}
async function me(token, req) { const { doc } = await qr.resolve(token); return { account: view(await need(req, doc.businessId)) }; }

/** After signing in, receipts paid earlier on this phone (their references are kept in the browser) join the account. */
async function claim(token, req, { references }) {
  const { doc } = await qr.resolve(token); const a = await need(req, doc.businessId);
  const r = await GuestReceipt.updateMany({ businessId: doc.businessId, reference: { $in: references.slice(0, 50) }, placeKey: String(doc._id), accountId: { $exists: false } }, { $set: { accountId: a._id } });
  await MpesaTransaction.updateMany({ businessId: doc.businessId, reference: { $in: references.slice(0, 50) }, 'guestPay.placeKey': String(doc._id), 'guestPay.accountId': { $exists: false } }, { $set: { 'guestPay.accountId': a._id } });
  return { claimed: r.modifiedCount || 0 };
}
async function history(token, req) {
  const { doc } = await qr.resolve(token); const a = await need(req, doc.businessId);
  const [rc, os] = await Promise.all([
    GuestReceipt.find({ businessId: doc.businessId, accountId: a._id }).sort({ createdAt: -1 }).limit(50).select('reference number total paidAmount paid kind createdAt snapshot.place snapshot.business.name'),
    GuestRequest.find({ businessId: doc.businessId, accountId: a._id }).sort({ createdAt: -1 }).limit(30),
  ]);
  return {
    account: view(a),
    receipts: rc.map((r) => ({ reference: r.reference, number: r.number, total: r.total, paid: r.paidAmount, kind: r.kind, place: r.snapshot && r.snapshot.place, at: r.createdAt })),
    orders: os.map((o) => ({ id: o._id, place: o.kind === 'TABLE' ? `Table ${o.tableName}` : `Room ${o.roomNumber}`, status: o.status, items: o.items.map((i) => ({ name: i.name, quantity: i.quantity })), estimatedTotal: Math.round(o.estimatedTotal) / 100, at: o.createdAt })),
  };
}
async function receiptOf(token, req, reference) {
  const { doc } = await qr.resolve(token); const a = await need(req, doc.businessId);
  const r = await GuestReceipt.findOne({ businessId: doc.businessId, accountId: a._id, reference }); if (!r) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
  return r.snapshot;
}
module.exports = { updateProfile, fromRequest, register, login, google, me, claim, history, receiptOf, view };
