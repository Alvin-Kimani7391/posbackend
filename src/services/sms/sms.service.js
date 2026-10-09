const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { normalizePhone, toLocalPhone } = require('../../utils/phone');
const { parseMpesaMessage } = require('../../utils/mpesaMessage');
const Customer = require('../../models/Customer');
const Business = require('../../models/Business');
const SubscriptionPayment = require('../../models/SubscriptionPayment');
const settingsSvc = require('../billing.settings');
const crm = require('../crm.service');
const adapter = require('./sms.payments.adapter');
const provider = require('./talksasa.provider');
const M = require('../../models/sms.models');

const DOC_DIR = process.env.SMS_DOC_DIR || path.join(process.cwd(), 'private_uploads', 'sms');
const rid = (p) => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/* ------------------------------ settings & offers ------------------------------ */
async function getSettings() {
  return M.SmsSettings.findOneAndUpdate({ key: 'global' }, { $setOnInsert: { key: 'global' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
}
async function updateSettings(patch) {
  const allowed = ['networks', 'retailPriceCents', 'wholesaleCostCents', 'minTopupCents', 'stkEnabled', 'manualEnabled', 'paybill', 'manualInstructions'];
  const $set = {};
  allowed.forEach((k) => { if (patch[k] !== undefined) $set[k] = patch[k]; });
  await getSettings();
  return M.SmsSettings.findOneAndUpdate({ key: 'global' }, { $set }, { new: true }).lean();
}
async function activeOffers() {
  const now = new Date();
  return M.SmsOffer.find({
    active: true,
    $and: [{ $or: [{ startsAt: null }, { startsAt: { $lte: now } }] }, { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }],
  }).sort({ sortOrder: 1, priceCents: 1 }).lean();
}

/* ------------------------------ wallet ------------------------------ */
async function getWallet(businessId) {
  return M.SmsWallet.findOneAndUpdate({ businessId }, { $setOnInsert: { businessId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
}
/** Idempotent: a repeated reference never credits twice. */
async function creditWallet(businessId, credits, { type, reference, amountCents = 0, note }) {
  try { await M.SmsLedger.create({ businessId, type, credits, amountCents, reference, note }); }
  catch (e) { if (e.code === 11000) return false; throw e; }
  await M.SmsWallet.updateOne({ businessId }, { $inc: { availableCredits: credits, totalPurchased: type === 'TOPUP' ? credits : 0 } }, { upsert: true });
  return true;
}
async function reserveCredits(businessId, n, reference) {
  await getWallet(businessId);
  const w = await M.SmsWallet.findOneAndUpdate({ businessId, availableCredits: { $gte: n } }, { $inc: { availableCredits: -n } }, { new: true });
  if (!w) throw ApiError.badRequest('Not enough SMS credits. Please buy more credits.');
  await M.SmsLedger.create({ businessId, type: 'CAMPAIGN_RESERVE', credits: -n, reference, note: 'Campaign reserve' }).catch(() => {});
  return w;
}
async function adminAdjust(businessId, credits, note) {
  const ref = rid('ADJ');
  if (!Number.isFinite(credits) || credits === 0) throw ApiError.badRequest('Enter a number of credits');
  await getWallet(businessId);
  if (credits < 0) {
    const w = await M.SmsWallet.findOneAndUpdate({ businessId, availableCredits: { $gte: -credits } }, { $inc: { availableCredits: credits } }, { new: true });
    if (!w) throw ApiError.badRequest('Wallet has fewer credits than the deduction');
    await M.SmsLedger.create({ businessId, type: 'ADJUSTMENT', credits, reference: ref, note });
  } else await creditWallet(businessId, credits, { type: 'ADJUSTMENT', reference: ref, note });
  return getWallet(businessId);
}

/* ------------------------------ documents (protected) ------------------------------ */
const OK_MIME = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };
function saveFile(f) {
  if (!f) return undefined;
  const ext = OK_MIME[f.mimetype];
  if (!ext) throw ApiError.badRequest('Only PDF, PNG or JPG files are allowed');
  fs.mkdirSync(DOC_DIR, { recursive: true });
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(DOC_DIR, file), f.buffer);
  return { file, mime: f.mimetype, name: f.originalname };
}
async function readDocument(app, kind) {
  if (!['legal', 'signature', 'stamp'].includes(kind)) throw ApiError.notFound('Document not found');
  const d = app.toObject().documents && app.toObject().documents[kind];
  if (!d || !d.file) throw ApiError.notFound('Document not found');
  const buf = fs.readFileSync(path.join(DOC_DIR, path.basename(d.file)));
  return { mime: d.mime, name: d.name || `${kind}.${OK_MIME[d.mime]}`, base64: buf.toString('base64') };
}

/* ------------------------------ sender ID applications ------------------------------ */
const SID_RE = /^[A-Za-z]+([ .\-_][A-Za-z]+)*$/;
const KRA_RE = /^[AP]\d{9}[A-Z]$/i;

async function feeQuote(networkKeys) {
  const s = await getSettings();
  const nets = s.networks.filter((n) => n.enabled && networkKeys.includes(n.key));
  if (!nets.length) throw ApiError.badRequest('Select at least one network');
  return { nets, total: nets.reduce((a, n) => a + n.providerCostCents + n.serviceFeeCents, 0) };
}

function validateApp(b) {
  const e = [];
  const sid = String(b.senderId || '').trim();
  if (!sid || sid.length > 11 || !SID_RE.test(sid)) e.push('Sender ID: letters only, no digits, max 11 characters (separators: space - _ .)');
  if (!['transactional', 'promotional', 'informational'].includes(b.purpose)) e.push('Choose a purpose');
  if (!b.legalName) e.push('Legal / registered name is required');
  if (!KRA_RE.test(String(b.kraPin || ''))) e.push('Enter a valid KRA PIN (e.g. P051234567X)');
  ['signatoryTitle', 'signatoryName', 'phone', 'email'].forEach((k) => { if (!b[k]) e.push(`${k} is required`); });
  if (!normalizePhone(b.phone)) e.push('Enter a valid signatory phone');
  const samples = [].concat(b.samples || []).map((x) => String(x).trim()).filter(Boolean);
  if (samples.length < 2) e.push('Provide 2 sample messages');
  if (!(b.accepted === true || b.accepted === 'true')) e.push('You must accept the authorisation statements');
  if (e.length) throw ApiError.badRequest(e.join(' · '));
  return { sid, samples };
}

async function saveApplication(businessId, id, body, files) {
  const { sid, samples } = validateApp(body);
  const keys = [].concat(body.networks || []);
  const { nets, total } = await feeQuote(keys);
  const app = id ? await M.SmsSenderIdApplication.findOne({ _id: id, businessId }) : null;
  if (id && !app) throw ApiError.notFound('Application not found');
  if (app && !['draft', 'needs_info'].includes(app.approvalStatus)) throw ApiError.badRequest('This application can no longer be edited');
  const dup = await M.SmsSenderId.findOne({ senderId: new RegExp(`^${sid}$`, 'i'), businessId: { $ne: businessId }, status: 'active' }).lean();
  if (dup) throw ApiError.conflict('That Sender ID is already taken by another business');

  const docs = { ...((app && app.toObject().documents) || {}) };
  ['legal', 'signature', 'stamp'].forEach((k) => { const f = saveFile(files && files[k] && files[k][0]); if (f) docs[k] = f; });
  if (!docs.legal || !docs.signature || !docs.stamp) throw ApiError.badRequest('Legal document, signature and stamp are all required');

  const data = {
    businessId, senderId: sid, purpose: body.purpose, samples, accepted: true, documents: docs,
    legalName: body.legalName, tradingName: body.tradingName, kraPin: String(body.kraPin).toUpperCase(),
    signatoryTitle: body.signatoryTitle, signatoryName: body.signatoryName, phone: body.phone, email: body.email,
    totalCents: total,
  };
  if (app) {
    const resubmitting = app.approvalStatus === 'needs_info';
    Object.assign(app, data);
    if (resubmitting) {
      app.approvalStatus = 'pending';
      app.networks.forEach((n) => { if (n.status === 'needs_info') n.status = 'pending'; });
    } else {
      app.networks = nets.map((n) => ({ key: n.key, name: n.name, providerCostCents: n.providerCostCents, serviceFeeCents: n.serviceFeeCents, status: 'pending_payment' }));
    }
    return app.save();
  }
  return M.SmsSenderIdApplication.create({
    ...data, reference: rid('SID'),
    networks: nets.map((n) => ({ key: n.key, name: n.name, providerCostCents: n.providerCostCents, serviceFeeCents: n.serviceFeeCents, status: 'pending_payment' })),
  });
}

async function setNetworkStatus(appId, networkKey, { status, note }) {
  if (!['pending', 'submitted', 'approved', 'rejected', 'needs_info'].includes(status)) throw ApiError.badRequest('Invalid status');
  const app = await M.SmsSenderIdApplication.findById(appId);
  if (!app) throw ApiError.notFound('Application not found');
  if (app.paymentStatus !== 'paid') throw ApiError.badRequest('Payment has not been verified yet');
  const n = app.networks.find((x) => x.key === networkKey);
  if (!n) throw ApiError.notFound('Network not on this application');
  n.status = status; n.note = note; n.updatedAt = new Date();
  if (status === 'approved') {
    await M.SmsSenderId.updateOne({ businessId: app.businessId, senderId: app.senderId, network: n.key },
      { $set: { status: 'active', applicationId: app._id } }, { upsert: true });
  } else {
    await M.SmsSenderId.updateOne({ businessId: app.businessId, senderId: app.senderId, network: n.key }, { $set: { status: 'revoked' } });
  }
  const st = app.networks.map((x) => x.status);
  if (st.every((s) => s === 'approved')) app.approvalStatus = 'approved';
  else if (st.some((s) => s === 'approved')) app.approvalStatus = 'partial';
  else if (st.some((s) => s === 'needs_info')) app.approvalStatus = 'needs_info';
  else if (st.every((s) => s === 'rejected')) app.approvalStatus = 'rejected';
  else app.approvalStatus = 'pending';
  return app.save();
}

/* ------------------------------ payments ------------------------------ */
async function createPayment(businessId, userId, { purpose, applicationId, offerId, amount, method, phone, mpesaMessage }) {
  const s = await getSettings();
  if (!['STK', 'MANUAL'].includes(method)) throw ApiError.badRequest('Choose a payment method');
  if (method === 'STK' && !s.stkEnabled) throw ApiError.badRequest('M-PESA prompt is currently unavailable');
  if (method === 'MANUAL' && !s.manualEnabled) throw ApiError.badRequest('Manual payment is currently unavailable');

  let amountCents; let credits = 0; let label; let app = null; let offer = null; let prefix;
  if (purpose === 'SENDER_ID') {
    app = await M.SmsSenderIdApplication.findOne({ _id: applicationId, businessId });
    if (!app) throw ApiError.notFound('Application not found');
    if (app.paymentStatus === 'paid') throw ApiError.badRequest('Already paid');
    if (app.paymentStatus === 'awaiting_verification') throw ApiError.badRequest('A payment for this application is already awaiting verification');
    if (!['draft'].includes(app.approvalStatus)) throw ApiError.badRequest('Application not payable');
    amountCents = app.totalCents; prefix = 'SID';
    label = `Sender ID registration - ${app.senderId} (${app.networks.map((n) => n.name).join(', ')})`;
  } else if (purpose === 'SMS_TOPUP') {
    prefix = 'SMS';
    if (offerId) {
      offer = (await activeOffers()).find((o) => String(o._id) === String(offerId));
      if (!offer) throw ApiError.badRequest('That offer is no longer available');
      amountCents = offer.priceCents; credits = offer.credits + (offer.bonusCredits || 0);
      label = `SMS credits - ${offer.name} (${credits} credits)`;
    } else {
      amountCents = Math.round(Number(amount) * 100);
      if (!(amountCents >= s.minTopupCents)) throw ApiError.badRequest(`Minimum top-up is KES ${s.minTopupCents / 100}`);
      credits = Math.floor(amountCents / s.retailPriceCents);
      label = `SMS credits - custom top-up (${credits} credits)`;
    }
  } else throw ApiError.badRequest('Invalid purpose');

  // expire stale STK attempts so the owner can retry
  await M.SmsPayment.updateMany({ businessId, method: 'STK', status: 'PENDING', createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) } },
    { $set: { status: 'FAILED', failureReason: 'Expired' } });

  const pay = { businessId, userId, purpose, label, reference: rid(prefix), amountCents, method, credits, applicationId: app ? app._id : undefined, offerId: offer ? offer._id : undefined };

  if (method === 'STK') {
    const p = normalizePhone(phone);
    if (!p) throw ApiError.badRequest('Enter a valid M-PESA phone number');
    pay.phone = toLocalPhone(p);
    const created = await M.SmsPayment.create(pay);
    try {
      const biz = await Business.findById(businessId).select('name').lean();
      const r = await adapter.initiateStk({ amountCents, phone: pay.phone, reference: created.reference, businessName: biz && biz.name });
      created.providerRef = r.providerRef; await created.save();
    } catch (e) {
      created.status = 'FAILED'; created.failureReason = e.message; await created.save();
      throw e;
    }
    return created;
  }

  // MANUAL: the owner pastes the M-PESA message; an admin verifies against the statement
  const parsed = parseMpesaMessage(mpesaMessage);
  if (!parsed.code) throw ApiError.badRequest('Paste the full M-PESA confirmation message (it starts with a 10-character code and the word "Confirmed").');
  if (await SubscriptionPayment.exists({ receiptKey: parsed.code }) || await M.SmsPayment.exists({ mpesaCode: parsed.code })) {
    throw ApiError.conflict('That M-PESA code has already been submitted.');
  }
  if (await M.SmsPayment.countDocuments({ businessId, method: 'MANUAL', status: 'AWAITING_VERIFICATION' }) >= 5) {
    throw ApiError.badRequest('You already have several payments waiting for verification. Please wait for them to be reviewed.');
  }
  const bs = await settingsSvc.get();
  pay.mpesaCode = parsed.code;
  pay.mpesaMessage = parsed.text.slice(0, 1000);
  pay.claimedCents = parsed.amountCents == null ? undefined : parsed.amountCents;
  pay.flags = [];
  if (parsed.amountCents == null) pay.flags.push('Amount not found in the message');
  else if (parsed.amountCents < amountCents) pay.flags.push(`Paid KES ${parsed.amountCents / 100} but KES ${amountCents / 100} is due`);
  if (parsed.looksReceived) pay.flags.push('Looks like a "received" message, not a payment');
  const targets = [bs.manual?.number, bs.manual?.accountName, bs.manual?.phone].filter(Boolean).map((x) => String(x).toUpperCase().replace(/\s+/g, ''));
  if (targets.length && !targets.some((t) => parsed.text.toUpperCase().replace(/\s+/g, '').includes(t))) pay.flags.push('Recipient not found in the message');
  pay.status = 'AWAITING_VERIFICATION';

  let created;
  try { created = await M.SmsPayment.create(pay); }
  catch (e) { if (e.code === 11000) throw ApiError.conflict('That M-PESA code has already been submitted.'); throw e; }
  if (app) { app.paymentStatus = 'awaiting_verification'; app.paymentId = created._id; await app.save(); }
  return created;
}

/** The ONLY place a payment becomes PAID. Atomic, so poll + job + admin can race safely. */
async function settlePayment(paymentId, { verifiedBy, mpesaCode, force } = {}) {
  const pre = await M.SmsPayment.findById(paymentId).lean();
  if (pre && pre.method === 'MANUAL' && pre.claimedCents != null && pre.claimedCents < pre.amountCents && !force) {
    throw ApiError.badRequest(`The owner paid KES ${pre.claimedCents / 100} but KES ${pre.amountCents / 100} is due. Reject it and ask them to pay the full amount.`);
  }
  const p = await M.SmsPayment.findOneAndUpdate(
    { _id: paymentId, status: { $in: ['PENDING', 'AWAITING_VERIFICATION'] } },
    { $set: { status: 'PAID', settledAt: new Date(), ...(verifiedBy && { verifiedBy }) } }, { new: true });
  if (!p) return null;
  if (mpesaCode && !p.mpesaCode) {
    try { await M.SmsPayment.updateOne({ _id: p._id }, { $set: { mpesaCode } }); } catch (e) { if (e.code !== 11000) throw e; }
  }
  try {
    if (p.purpose === 'SMS_TOPUP') await creditWallet(p.businessId, p.credits, { type: 'TOPUP', reference: p.reference, amountCents: p.amountCents, note: p.label });
    else {
      await M.SmsSenderIdApplication.updateOne({ _id: p.applicationId }, { $set: { paymentStatus: 'paid', paymentId: p._id, approvalStatus: 'pending', 'networks.$[].status': 'pending' } });
    }
  } catch (e) {
    await M.SmsPayment.updateOne({ _id: p._id }, { $set: { status: pre ? pre.status : 'PENDING' } }); // allow retry
    throw e;
  }
  adapter.mirrorToBilling(p).catch((e) => console.error('[sms] mirror failed', e.message));
  return p;
}

async function refreshPayment(businessId, id) {
  const p = await M.SmsPayment.findOne({ _id: id, businessId });
  if (!p) throw ApiError.notFound('Payment not found');
  if (p.method === 'STK' && p.status === 'PENDING' && p.providerRef) {
    const r = await adapter.checkStk(p.providerRef, p.amountCents, p.createdAt);
    if (r.state === 'SUCCESS') await settlePayment(p._id, { mpesaCode: r.receipt });
    else if (r.state === 'FAILED') await M.SmsPayment.updateOne({ _id: p._id, status: 'PENDING' }, { $set: { status: 'FAILED', failureReason: r.reason } });
    else if (Date.now() - p.createdAt.getTime() > 5 * 60 * 1000) await M.SmsPayment.updateOne({ _id: p._id, status: 'PENDING' }, { $set: { status: 'FAILED', failureReason: 'No response from the phone in time' } });
    return M.SmsPayment.findById(id).lean();
  }
  return p.toObject();
}

async function rejectPayment(id, note, adminId) {
  const p = await M.SmsPayment.findOneAndUpdate({ _id: id, status: 'AWAITING_VERIFICATION' },
    { $set: { status: 'REJECTED', note, verifiedBy: adminId }, $unset: { mpesaCode: 1 } }, { new: true });
  if (!p) throw ApiError.badRequest('Payment is not awaiting verification');
  if (p.applicationId) await M.SmsSenderIdApplication.updateOne({ _id: p.applicationId }, { $set: { paymentStatus: 'unpaid' } });
  return p;
}

/* ------------------------------ campaigns ------------------------------ */
const PLACEHOLDERS = [
  { key: 'name', label: 'Full name' }, { key: 'firstName', label: 'First name' }, { key: 'phone', label: 'Phone' },
  { key: 'shop', label: 'Your business name' }, { key: 'totalSpent', label: 'Total spent (KES)' },
  { key: 'visits', label: 'Number of purchases' }, { key: 'lastPurchase', label: 'Last purchase date' },
  { key: 'offer', label: 'Your custom offer text' },
];
function render(tpl, ctx) {
  return String(tpl).replace(/\{(\w+)(?:\|([^}]*))?\}/g, (m, k, fb) => {
    const v = ctx[k];
    return v !== undefined && v !== null && String(v) !== '' ? String(v) : (fb !== undefined ? fb : (k === 'name' || k === 'firstName' ? 'Customer' : ''));
  });
}
function segmentsOf(text) {
  const uni = /[^\x00-\x7F]/.test(text);
  const len = [...text].length;
  const single = uni ? 70 : 160; const multi = uni ? 67 : 153;
  return len <= single ? 1 : Math.ceil(len / multi);
}

async function buildPlan(businessId, body, shopName) {
  const message = String(body.message || '').trim();
  if (!message) throw ApiError.badRequest('Write a message');
  if (message.length > 1000) throw ApiError.badRequest('Message is too long');
  const extra = { offer: body.offerText || '', shop: shopName || '' };

  let rows = [];
  if (body.segmentId) {
    const seg = await crm.resolveSegment(businessId, body.segmentId);
    const f = crm.customerFilter(businessId, { rules: seg.rules, match: seg.match });
    f.$and.push({ phoneNormalized: { $type: 'string' } }, { smsOptOut: { $ne: true } });
    rows = await Customer.find(f).limit(50000).select('name phoneNormalized crm').lean();
  } else if (Array.isArray(body.customerIds) && body.customerIds.length) {
    rows = await Customer.find({ businessId, _id: { $in: body.customerIds.filter(mongoose.isValidObjectId) }, phoneNormalized: { $type: 'string' }, smsOptOut: { $ne: true } }).select('name phoneNormalized crm').lean();
  }
  const manual = String(body.numbers || '').split(/[\s,;]+/).map(normalizePhone).filter(Boolean).map((p) => ({ name: '', phoneNormalized: p }));
  rows = [...rows, ...manual];

  const seen = new Set(); const recipients = []; let credits = 0;
  for (const c of rows) {
    if (seen.has(c.phoneNormalized)) continue; seen.add(c.phoneNormalized);
    const x = c.crm || {};
    const full = (c.name || '').trim();
    const text = render(message, {
      ...extra, name: full, firstName: full.split(/\s+/)[0], phone: toLocalPhone(c.phoneNormalized),
      totalSpent: x.totalSpentCents ? Math.round(x.totalSpentCents / 100).toLocaleString('en-KE') : '',
      visits: x.purchaseCount || '', lastPurchase: x.lastPurchaseAt ? new Date(x.lastPurchaseAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }) : '',
    }).replace(/\s{2,}/g, ' ').trim();
    const segments = segmentsOf(text);
    credits += segments;
    recipients.push({ customerId: c._id, name: full, phone: c.phoneNormalized, text, segments });
  }
  if (!recipients.length) throw ApiError.badRequest('No eligible recipients (customers need a valid phone and must not have opted out)');
  return { recipients, credits, sample: recipients[0].text };
}

async function quote(businessId, body, shopName) {
  const plan = await buildPlan(businessId, body, shopName);
  const w = await getWallet(businessId);
  return { recipients: plan.recipients.length, credits: plan.credits, balance: w.availableCredits, enough: w.availableCredits >= plan.credits, sample: plan.sample };
}

async function createCampaign(businessId, userId, body, shopName) {
  const type = ['promotional', 'transactional', 'informational'].includes(body.type) ? body.type : 'promotional';
  if (type === 'promotional' && !(body.consentConfirmed === true || body.consentConfirmed === 'true')) {
    throw ApiError.badRequest('Confirm that these customers agreed to receive marketing messages');
  }
  const sid = await M.SmsSenderId.findOne({ businessId, senderId: body.senderId, status: 'active' }).lean();
  if (!sid) throw ApiError.badRequest('That Sender ID is not approved for your business yet');

  const plan = await buildPlan(businessId, body, shopName);
  const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : null;
  const later = scheduledAt && scheduledAt.getTime() > Date.now() + 60 * 1000;
  const campaign = await M.SmsCampaign.create({
    businessId, createdBy: userId, name: body.name || `Campaign ${new Date().toLocaleDateString('en-KE')}`, message: body.message,
    senderId: sid.senderId, type,
    audience: { kind: body.segmentId ? 'segment' : (body.customerIds && body.customerIds.length ? 'customers' : 'numbers'), segmentId: body.segmentId, count: plan.recipients.length },
    scheduledAt: later ? scheduledAt : null, status: later ? 'scheduled' : 'queued', recipients: plan.recipients.length, credits: plan.credits,
  });
  try {
    await reserveCredits(businessId, plan.credits, `camp:${campaign._id}`);
  } catch (e) { await M.SmsCampaign.deleteOne({ _id: campaign._id }); throw e; }
  try {
    await M.SmsMessage.insertMany(plan.recipients.map((r) => ({
      businessId, campaignId: campaign._id, customerId: r.customerId, name: r.name, phone: r.phone, text: r.text, segments: r.segments,
      senderId: sid.senderId, status: later ? 'held' : 'queued',
    })), { ordered: false });
  } catch (e) {
    await M.SmsMessage.deleteMany({ campaignId: campaign._id });
    await creditWallet(businessId, plan.credits, { type: 'CAMPAIGN_REFUND', reference: `camp-fail:${campaign._id}` });
    await M.SmsCampaign.deleteOne({ _id: campaign._id });
    throw e;
  }
  return campaign;
}

async function cancelCampaign(businessId, id) {
  const c = await M.SmsCampaign.findOne({ _id: id, businessId });
  if (!c) throw ApiError.notFound('Campaign not found');
  if (!['scheduled', 'queued', 'sending'].includes(c.status)) throw ApiError.badRequest('Campaign already finished');
  const r = await M.SmsMessage.aggregate([{ $match: { campaignId: c._id, status: { $in: ['held', 'queued'] } } }, { $group: { _id: null, n: { $sum: '$segments' } } }]);
  await M.SmsMessage.updateMany({ campaignId: c._id, status: { $in: ['held', 'queued'] } }, { $set: { status: 'cancelled' } });
  const back = r[0] ? r[0].n : 0;
  if (back) await creditWallet(businessId, back, { type: 'CAMPAIGN_REFUND', reference: `cancel:${c._id}`, note: 'Cancelled campaign' });
  c.status = 'cancelled'; c.refundedCredits += back; await c.save();
  return c;
}

async function campaignStats(campaignId) {
  const rows = await M.SmsMessage.aggregate([{ $match: { campaignId: new mongoose.Types.ObjectId(String(campaignId)) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  return Object.fromEntries(rows.map((r) => [r._id, r.n]));
}

/* ------------------------------ queue worker ------------------------------ */
let running = false;
async function processQueue() {
  if (running) return; running = true;
  try {
    const now = new Date();
    const due = await M.SmsCampaign.find({ status: 'scheduled', scheduledAt: { $lte: now } }).select('_id').lean();
    for (const c of due) {
      await M.SmsMessage.updateMany({ campaignId: c._id, status: 'held' }, { $set: { status: 'queued', nextAttemptAt: now } });
      await M.SmsCampaign.updateOne({ _id: c._id }, { $set: { status: 'queued' } });
    }
    const touched = new Set();
    for (let round = 0; round < 25; round++) {
      const batch = [];
      for (let i = 0; i < 10; i++) {
        const m = await M.SmsMessage.findOneAndUpdate({ status: 'queued', nextAttemptAt: { $lte: new Date() } },
          { $set: { status: 'sending' }, $inc: { attempts: 1 } }, { sort: { createdAt: 1 }, new: true });
        if (!m) break; batch.push(m);
      }
      if (!batch.length) break;
      await Promise.all(batch.map(async (m) => {
        touched.add(String(m.campaignId));
        const r = await provider.sendSms({ to: m.phone, senderId: m.senderId, message: m.text });
        if (r.ok) {
          await M.SmsMessage.updateOne({ _id: m._id }, { $set: { status: 'sent', providerMessageId: r.providerMessageId, sentAt: new Date() } });
          await M.SmsWallet.updateOne({ businessId: m.businessId }, { $inc: { totalSent: m.segments } });
        } else if (r.retry && m.attempts < 3) {
          await M.SmsMessage.updateOne({ _id: m._id }, { $set: { status: 'queued', error: r.error, nextAttemptAt: new Date(Date.now() + 60000 * m.attempts) } });
        } else {
          await M.SmsMessage.updateOne({ _id: m._id }, { $set: { status: 'failed', error: r.error } });
          await refundMessage(m);
        }
      }));
    }
    for (const id of touched) await finalizeIfDone(id);
  } finally { running = false; }
}

async function refundMessage(m) {
  const ok = await creditWallet(m.businessId, m.segments, { type: 'CAMPAIGN_REFUND', reference: `msg:${m._id}`, note: 'Message failed' });
  if (ok) await M.SmsCampaign.updateOne({ _id: m.campaignId }, { $inc: { refundedCredits: m.segments } });
}
async function finalizeIfDone(campaignId) {
  const open = await M.SmsMessage.countDocuments({ campaignId, status: { $in: ['held', 'queued', 'sending'] } });
  await M.SmsCampaign.updateOne({ _id: campaignId, status: { $in: ['queued', 'sending'] } },
    open ? { $set: { status: 'sending' } } : { $set: { status: 'completed', completedAt: new Date() } });
}

/** Delivery reports from TalkSasa (verify field names against their docs). */
async function applyDeliveryReport({ id, status }) {
  if (!id) return;
  const s = String(status || '').toLowerCase();
  const m = await M.SmsMessage.findOne({ providerMessageId: String(id) });
  if (!m) return;
  if (/deliver/.test(s) && !/undeliver/.test(s) && m.status === 'sent') {
    await M.SmsMessage.updateOne({ _id: m._id }, { $set: { status: 'delivered', deliveredAt: new Date() } });
  } else if (/fail|undeliver|reject|expire/.test(s) && ['sent', 'delivered'].includes(m.status)) {
    await M.SmsMessage.updateOne({ _id: m._id }, { $set: { status: 'failed', error: s.slice(0, 100) } });
    await refundMessage(m);
  }
}

/** Confirms STK payments the owner left waiting on (page closed). */
async function reconcilePayments() {
  const open = await M.SmsPayment.find({ method: 'STK', status: 'PENDING', providerRef: { $exists: true }, createdAt: { $gt: new Date(Date.now() - 15 * 60 * 1000) } }).limit(50);
  for (const p of open) {
    try { await refreshPayment(p.businessId, p._id); } catch (e) { console.error('[sms] reconcile', e.message); }
  }
}

module.exports = {
  PLACEHOLDERS, getSettings, updateSettings, activeOffers, getWallet, adminAdjust,
  feeQuote, saveApplication, setNetworkStatus, readDocument,
  createPayment, settlePayment, refreshPayment, rejectPayment,
  quote, createCampaign, cancelCampaign, campaignStats,
  processQueue, applyDeliveryReport, reconcilePayments,
};