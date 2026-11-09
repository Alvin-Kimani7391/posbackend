/** Returns 503 for normal traffic while shared/maintenance.flag exists. Payment callbacks, health and platform-admin still work. */
const fs = require('fs');
const path = require('path');
const FLAG = path.join(process.env.INFRA_BASE || '/var/www/sixstar-pos', 'shared/maintenance.flag');
const ALLOW = [/^\/health/, /^\/api\/v1\/admin(\/|$)/, /^\/api\/v1\/payments\/mpesa\/callback\//, /^\/api\/v1\/billing\/callback\//, /^\/api\/v1\/sms-hooks(\/|$)/];
let on = false, at = 0;
module.exports = function maintenance(req, res, next) {
  const now = Date.now();
  if (now - at > 2000) { at = now; try { on = fs.existsSync(FLAG); } catch { on = false; } } // 1 stat per 2s, not per request
  if (!on || ALLOW.some((r) => r.test(req.path))) return next();
  res.set('Retry-After', '120');
  res.status(503).json({ success: false, code: 'MAINTENANCE', message: 'Six Star POS is under brief maintenance. Please try again in a few minutes.' });
};
