const router = require('express').Router();
const sms = require('../services/sms/sms.service');

const guard = (req, res, next) => {
  const secret = process.env.SMS_WEBHOOK_SECRET;
  if (!secret || req.query.s !== secret) return res.status(401).json({ success: false });
  next();
};

// TalkSasa delivery reports: set the DLR URL to {API}/api/v1/sms-hooks/talksasa?s=<SMS_WEBHOOK_SECRET>
router.post('/talksasa', guard, async (req, res) => {
  try {
    const b = req.body || {};
    await sms.applyDeliveryReport({ id: b.uid || b.message_id || b.id, status: b.status || b.delivery_status });
  } catch (e) { console.error('[sms] webhook', e.message); }
  res.json({ success: true });
});

// PayHero callback for SMS payments: money is confirmed by a live status check (poll + job), so just acknowledge.
router.post('/payhero', (req, res) => res.json({ success: true }));

module.exports = router;