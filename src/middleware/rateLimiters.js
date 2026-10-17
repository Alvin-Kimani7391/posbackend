const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' },
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests', code: 'RATE_LIMITED' },
});

const callbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.businessId || ''}:${(req.body && req.body.deviceId) || (req.query && req.query.deviceId) || req.ip}`,
  message: { success: false, message: 'Too many sync requests', code: 'RATE_LIMITED' },
});
// Receipt verification: a person scanning receipts at a door is fast, but a script guessing tokens must be stopped.
const receiptVerifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.businessId || ''}:${req.user ? req.user._id : req.ip}`,
  message: { success: false, message: 'Too many verifications, wait a moment', code: 'RATE_LIMITED' },
});
module.exports = { authLimiter, publicApiLimiter, callbackLimiter, syncLimiter, receiptVerifyLimiter };