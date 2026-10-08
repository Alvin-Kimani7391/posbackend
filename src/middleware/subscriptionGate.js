/**
 * Soft lock. When a business is locked for non-payment (or by admin) every tenant API call returns
 * 402 SUBSCRIPTION_LOCKED EXCEPT the routes the owner needs to log in, pay, read notices and ask for help.
 * Fails OPEN: a bug in billing must never take a paying shop offline.
 */
const { authenticate } = require('./auth');
const Subscription = require('../models/Subscription');
const settingsSvc = require('../services/billing.settings');
const lockCache = require('../utils/lockCache');

const ALWAYS_ALLOWED = [
  /^\/auth(\/|$)/, /^\/billing(\/|$)/, /^\/announcements(\/|$)/, /^\/notifications(\/|$)/,
  /^\/tickets(\/|$)/, /^\/admin(\/|$)/, /^\/payments\/mpesa\/(callback|c2b)(\/|$)/,
];

async function isLocked(businessId) {
  const cached = lockCache.get(businessId);
  if (cached !== undefined) return cached;
  const settings = await settingsSvc.get();
  let locked = false;
  if (settings.billingEnabled) {
    const sub = await Subscription.findOne({ businessId }).select('status lock').lean();
    locked = !!(sub && sub.status === 'SUSPENDED' && sub.lock?.active);
  }
  lockCache.set(businessId, locked);
  return locked;
}

function subscriptionGate(req, res, next) {
  if (ALWAYS_ALLOWED.some((re) => re.test(req.path))) return next();
  if (req.method === 'GET' && /^\/business\/?$/.test(req.path)) return next();
  if (!req.headers.authorization) return next(); // downstream authenticate will answer 401

  authenticate(req, res, async (err) => {
    if (err) return next(err);
    try {
      const businessId = req.businessId || req.user?.businessId;
      if (!businessId || req.user?.role === 'SUPER_ADMIN') return next();
      if (!(await isLocked(businessId))) return next();
      return res.status(402).json({
        success: false, code: 'SUBSCRIPTION_LOCKED',
        message: 'Your account is locked because of an unpaid balance. Open the Billing page to pay and restore access.',
      });
    } catch (e) {
      console.error('[subscriptionGate] check failed - allowing request', e.message);
      return next();
    }
  });
}

module.exports = subscriptionGate;