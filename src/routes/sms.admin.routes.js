const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const sms = require('../services/sms/sms.service');
const M = require('../models/sms.models');
const Business = require('../models/Business');

const ok = (res, data, msg = 'OK', code = 200) => sendSuccess(res, code, msg, data);
const uid = (req) => (req.user && req.user._id) || req.userId;
const withNames = async (items) => {
  const biz = await Business.find({ _id: { $in: items.map((i) => i.businessId) } }).select('name').lean();
  const name = new Map(biz.map((b) => [String(b._id), b.name]));
  return items.map((i) => ({ ...i, businessName: name.get(String(i.businessId)) }));
};

router.get('/overview', catchAsync(async (req, res) => {
  const [awaiting, pendingApps, paid, wallets, campaigns, s] = await Promise.all([
    M.SmsPayment.countDocuments({ status: 'AWAITING_VERIFICATION' }),
    M.SmsSenderIdApplication.countDocuments({ approvalStatus: { $in: ['pending', 'partial'] }, paymentStatus: 'paid' }),
    M.SmsPayment.aggregate([{ $match: { status: 'PAID' } }, { $group: { _id: '$purpose', cents: { $sum: '$amountCents' }, credits: { $sum: '$credits' }, n: { $sum: 1 } } }]),
    M.SmsWallet.aggregate([{ $group: { _id: null, credits: { $sum: '$availableCredits' }, sent: { $sum: '$totalSent' } } }]),
    M.SmsCampaign.countDocuments({ status: { $in: ['queued', 'sending', 'scheduled'] } }),
    sms.getSettings(),
  ]);
  const topup = paid.find((p) => p._id === 'SMS_TOPUP') || { cents: 0, credits: 0 };
  const sid = paid.find((p) => p._id === 'SENDER_ID') || { cents: 0 };
  const w = wallets[0] || { credits: 0, sent: 0 };
  ok(res, {
    awaitingVerification: awaiting, applicationsToProcess: pendingApps, activeCampaigns: campaigns,
    revenue: { smsCents: topup.cents, senderIdCents: sid.cents, smsMarginCents: topup.cents - topup.credits * s.wholesaleCostCents },
    customerCreditsOutstanding: w.credits, totalSent: w.sent,
  });
}));

/* sender ID applications: everything TalkSasa asks for */
router.get('/applications', catchAsync(async (req, res) => {
  const q = {}; if (req.query.status) q.approvalStatus = req.query.status;
  ok(res, await withNames(await M.SmsSenderIdApplication.find(q).select('-documents').sort({ createdAt: -1 }).limit(100).lean()));
}));
router.get('/applications/:id', catchAsync(async (req, res) => {
  const a = await M.SmsSenderIdApplication.findById(req.params.id).lean();
  if (!a) throw ApiError.notFound('Not found');
  const payment = a.paymentId ? await M.SmsPayment.findById(a.paymentId).select('-mpesaMessage').lean() : null;
  const b = await Business.findById(a.businessId).select('name').lean();
  ok(res, { ...a, documents: undefined, businessName: b && b.name, payment, documentKinds: Object.keys(a.documents || {}).filter((k) => a.documents[k] && a.documents[k].file) });
}));
router.get('/applications/:id/document/:kind', catchAsync(async (req, res) => {
  const a = await M.SmsSenderIdApplication.findById(req.params.id);
  if (!a) throw ApiError.notFound('Not found');
  ok(res, await sms.readDocument(a, req.params.kind));
}));
router.put('/applications/:id/network/:key', catchAsync(async (req, res) => ok(res, await sms.setNetworkStatus(req.params.id, req.params.key, req.body), 'Updated')));
router.put('/applications/:id', catchAsync(async (req, res) => {
  ok(res, await M.SmsSenderIdApplication.findByIdAndUpdate(req.params.id, { $set: { adminNote: req.body.adminNote } }, { new: true }), 'Saved');
}));

/* payments */
router.get('/payments', catchAsync(async (req, res) => {
  const q = {}; if (req.query.status) q.status = req.query.status; if (req.query.purpose) q.purpose = req.query.purpose;
  ok(res, await withNames(await M.SmsPayment.find(q).sort({ createdAt: -1 }).limit(100).lean()));
}));
router.post('/payments/:id/verify', catchAsync(async (req, res) => {
  const p = await sms.settlePayment(req.params.id, { verifiedBy: uid(req), force: req.body && req.body.force === true });
  if (!p) throw ApiError.badRequest('Payment is not waiting for verification');
  ok(res, p, 'Payment verified');
}));
router.post('/payments/:id/reject', catchAsync(async (req, res) => ok(res, await sms.rejectPayment(req.params.id, req.body.note, uid(req)), 'Rejected')));

/* dynamic offers */
router.get('/offers', catchAsync(async (req, res) => ok(res, await M.SmsOffer.find().sort({ sortOrder: 1, createdAt: -1 }).lean())));
const offerFields = (b) => ({
  name: b.name, description: b.description, label: b.label, credits: Number(b.credits), bonusCredits: Number(b.bonusCredits || 0),
  priceCents: Math.round(Number(b.price) * 100), startsAt: b.startsAt || null, endsAt: b.endsAt || null, active: b.active !== false, sortOrder: Number(b.sortOrder || 0),
});
router.post('/offers', catchAsync(async (req, res) => ok(res, await M.SmsOffer.create(offerFields(req.body)), 'Offer created', 201)));
router.put('/offers/:id', catchAsync(async (req, res) => ok(res, await M.SmsOffer.findByIdAndUpdate(req.params.id, { $set: offerFields(req.body) }, { new: true }), 'Offer updated')));
router.delete('/offers/:id', catchAsync(async (req, res) => { await M.SmsOffer.deleteOne({ _id: req.params.id }); ok(res, null, 'Deleted'); }));

/* pricing & settings */
router.get('/settings', catchAsync(async (req, res) => ok(res, await sms.getSettings())));
router.put('/settings', catchAsync(async (req, res) => ok(res, await sms.updateSettings(req.body), 'Saved')));

/* wallets */
router.get('/wallets', catchAsync(async (req, res) => ok(res, await withNames(await M.SmsWallet.find().sort({ availableCredits: -1 }).limit(200).lean()))));
router.post('/wallets/:businessId/adjust', catchAsync(async (req, res) => ok(res, await sms.adminAdjust(req.params.businessId, Math.round(Number(req.body.credits)), req.body.note || 'Admin adjustment'), 'Wallet adjusted')));

module.exports = router;