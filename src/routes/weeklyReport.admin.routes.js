/** Platform-admin: weekly report schedule, demo send, run now. Mounted at /api/v1/admin/weekly-report (super-admin only). */
const router = require('express').Router();
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const ApiError = require('../utils/ApiError');
const weekly = require('../services/weeklyReport');
const Settings = require('../models/WeeklyReportSettings');
const Business = require('../models/Business');

const ok = (res, data, msg = 'OK') => sendSuccess(res, 200, msg, data);
const uid = (req) => (req.user && req.user._id) || req.userId;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const shape = (s) => ({
  enabled: s.enabled, timezone: s.timezone, slots: s.slots.map((x) => ({ day: x.day, time: x.time })), lastRun: s.lastRun || null,
  labels: weekly.describeSlots(s.slots), emailConfigured: !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL),
});

router.get('/', catchAsync(async (req, res) => ok(res, shape(await weekly.getSettings()))));

router.put('/', catchAsync(async (req, res) => {
  const { enabled, slots } = req.body || {};
  const set = { updatedBy: uid(req) };
  if (typeof enabled === 'boolean') set.enabled = enabled;
  if (slots !== undefined) {
    if (!Array.isArray(slots) || slots.length > 14) throw new ApiError(400, 'Add between 0 and 14 send times.');
    const clean = []; const seen = new Set();
    for (const s of slots) {
      const day = Number(s && s.day); const time = String((s && s.time) || '');
      if (!Number.isInteger(day) || day < 0 || day > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ApiError(400, 'Each send time needs a weekday and a time like 10:00.');
      const k = `${day}-${time}`; if (!seen.has(k)) { seen.add(k); clean.push({ day, time }); }
    }
    set.slots = clean;
  }
  await weekly.getSettings();
  const s = await Settings.findOneAndUpdate({ key: 'weekly' }, { $set: set }, { new: true });
  ok(res, shape(s), 'Weekly report schedule saved');
}));

// Send a demo to ONE address. Real numbers of one shop (the one given, or the most recently active), never to the shop's own users.
router.post('/demo', catchAsync(async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ApiError(400, 'Enter a valid email address.');
  const r = await weekly.sendDemo({ email, businessId: req.body && req.body.businessId });
  if (!r.ok) {
    const why = { not_configured: 'Email is not configured on the server (set BREVO_API_KEY and BREVO_SENDER_EMAIL).', no_recipients: 'No recipient.', not_found: 'Business not found.' }[r.skipped] || r.error || 'The email could not be sent.';
    throw new ApiError(400, why);
  }
  ok(res, { sentTo: email, business: r.business }, `Demo sent to ${email} (using ${r.business}'s data)`);
}));

// Send the real report to every shop right now (same as the Saturday run). Needs confirm:true.
router.post('/run-now', catchAsync(async (req, res) => {
  if (!req.body || req.body.confirm !== true) throw new ApiError(400, 'Confirm that you want to email every shop now.');
  const r = await weekly.runAll({ trigger: 'manual' });
  ok(res, r, `Sent to ${r.sent} shop${r.sent === 1 ? '' : 's'}`);
}));

// Small business picker for the demo box.
router.get('/businesses', catchAsync(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const f = { status: 'active' }; if (q) f.name = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const rows = await Business.find(f).select('name').sort({ name: 1 }).limit(25).lean();
  ok(res, rows.map((b) => ({ id: b._id, name: b.name })));
}));

module.exports = router;
