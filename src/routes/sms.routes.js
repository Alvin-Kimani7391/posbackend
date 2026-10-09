const router = require('express').Router();
const multer = require('multer');
const { authenticate, requirePermission } = require('../middleware/auth');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const Business = require('../models/Business');
const sms = require('../services/sms/sms.service');
const adapter = require('../services/sms/sms.payments.adapter');
const M = require('../models/sms.models');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const docs = upload.fields([{ name: 'legal', maxCount: 1 }, { name: 'signature', maxCount: 1 }, { name: 'stamp', maxCount: 1 }]);

router.use(authenticate);
const view = requirePermission('reports.view');
const send = requirePermission('customers.update');
const pay = requirePermission('billing.pay');
const ok = (res, data, msg = 'OK', code = 200) => sendSuccess(res, code, msg, data);
const uid = (req) => (req.user && req.user._id) || req.userId;
const shopName = async (req) => { const b = await Business.findById(req.businessId).select('name').lean(); return (b && b.name) || ''; };
const arr = (v) => [].concat(v || []);

router.get('/overview', view, catchAsync(async (req, res) => {
  const b = req.businessId;
  const [wallet, senderIds, applications, offers, settings, campaigns, ledger, payment] = await Promise.all([
    sms.getWallet(b),
    M.SmsSenderId.find({ businessId: b, status: 'active' }).lean(),
    M.SmsSenderIdApplication.find({ businessId: b }).select('-documents').sort({ createdAt: -1 }).limit(20).lean(),
    sms.activeOffers(), sms.getSettings(),
    M.SmsCampaign.find({ businessId: b }).sort({ createdAt: -1 }).limit(30).lean(),
    M.SmsLedger.find({ businessId: b }).sort({ createdAt: -1 }).limit(20).lean(),
    adapter.paymentOptions(),
  ]);
  const { networks, retailPriceCents, minTopupCents, stkEnabled, manualEnabled, paybill, manualInstructions } = settings;
  ok(res, {
    wallet, senderIds, applications, offers, campaigns, ledger, payment, placeholders: sms.PLACEHOLDERS,
    pricing: {
      networks: networks.filter((n) => n.enabled).map((n) => ({ key: n.key, name: n.name, totalCents: n.providerCostCents + n.serviceFeeCents, providerCostCents: n.providerCostCents, serviceFeeCents: n.serviceFeeCents })),
      retailPriceCents, minTopupCents, stkEnabled, manualEnabled, paybill, manualInstructions,
    },
  });
}));

/* sender ID applications (multipart) */
const appBody = (req) => ({ ...req.body, networks: arr(req.body.networks || req.body['networks[]']), samples: arr(req.body.samples || req.body['samples[]']) });
router.post('/sender-id/applications', send, docs, catchAsync(async (req, res) => {
  ok(res, await sms.saveApplication(req.businessId, null, appBody(req), req.files), 'Application saved', 201);
}));
router.put('/sender-id/applications/:id', send, docs, catchAsync(async (req, res) => {
  ok(res, await sms.saveApplication(req.businessId, req.params.id, appBody(req), req.files), 'Application updated');
}));
router.get('/sender-id/applications/:id/document/:kind', view, catchAsync(async (req, res) => {
  const app = await M.SmsSenderIdApplication.findOne({ _id: req.params.id, businessId: req.businessId });
  if (!app) throw ApiError.notFound('Application not found');
  ok(res, await sms.readDocument(app, req.params.kind));
}));

/* payments (always labelled SID-xxxx / SMS-xxxx) */
router.post('/payments', pay, catchAsync(async (req, res) => {
  ok(res, await sms.createPayment(req.businessId, uid(req), req.body), 'Payment started', 201);
}));
router.get('/payments', view, catchAsync(async (req, res) => {
  ok(res, await M.SmsPayment.find({ businessId: req.businessId }).sort({ createdAt: -1 }).limit(50).select('-mpesaMessage').lean());
}));
router.get('/payments/:id', view, catchAsync(async (req, res) => ok(res, await sms.refreshPayment(req.businessId, req.params.id))));

/* campaigns */
router.post('/campaigns/quote', view, catchAsync(async (req, res) => ok(res, await sms.quote(req.businessId, req.body, await shopName(req)))));
router.post('/campaigns', send, catchAsync(async (req, res) => ok(res, await sms.createCampaign(req.businessId, uid(req), req.body, await shopName(req)), 'Campaign created', 201)));
router.post('/campaigns/:id/cancel', send, catchAsync(async (req, res) => ok(res, await sms.cancelCampaign(req.businessId, req.params.id), 'Cancelled')));
router.get('/campaigns/:id', view, catchAsync(async (req, res) => {
  const c = await M.SmsCampaign.findOne({ _id: req.params.id, businessId: req.businessId }).lean();
  if (!c) throw ApiError.notFound('Campaign not found');
  const messages = await M.SmsMessage.find({ campaignId: c._id }).limit(200).select('name phone status error sentAt deliveredAt text').lean();
  ok(res, { campaign: c, stats: await sms.campaignStats(c._id), messages });
}));

/* templates */
router.get('/templates', view, catchAsync(async (req, res) => ok(res, await M.SmsTemplate.find({ businessId: req.businessId }).sort({ name: 1 }).lean())));
router.post('/templates', send, catchAsync(async (req, res) => {
  const { name, body } = req.body;
  if (!name || !body) throw ApiError.badRequest('Name and message are required');
  ok(res, await M.SmsTemplate.create({ businessId: req.businessId, name, body }), 'Saved', 201);
}));
router.delete('/templates/:id', send, catchAsync(async (req, res) => { await M.SmsTemplate.deleteOne({ _id: req.params.id, businessId: req.businessId }); ok(res, null, 'Deleted'); }));

module.exports = router;