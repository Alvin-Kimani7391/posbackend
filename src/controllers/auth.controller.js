const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const authService = require('../services/auth.service');
const businessService = require('../services/business.service');

// Country block (flag, currency, "needs country selection") sent with every login so the dashboard can show the flag at once.
const countryOf = (user) => businessService.getCountrySummary(user.businessId).catch(() => null);

// On login the request has not been through authenticate(), so load the business's access policy first.
const primePolicy = async (user) => { if (user && user.businessId) { const B = require('../models/Business'); const b = await B.findById(user.businessId).select('permissionPolicy').lean(); require('../utils/permissionResolver').cachePolicy(user.businessId, b && b.permissionPolicy); } };

const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

exports.register = catchAsync(async (req, res) => {
  const { business, user } = await authService.registerBusinessOwner(req.body);
  return sendSuccess(res, 201, 'Business and owner account created', {
    business,
    user: user.toSafeJSON({ withPermissions: true }),
  });
});

exports.login = catchAsync(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.loginWithPassword(req.body, meta(req));
  await primePolicy(user);
  return sendSuccess(res, 200, 'Login successful', {
    user: user.toSafeJSON({ withPermissions: true }),
    country: await countryOf(user),
    accessToken,
    refreshToken,
  });
});

exports.pinLogin = catchAsync(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.loginWithPin(req.body, meta(req));
  await primePolicy(user);
  return sendSuccess(res, 200, 'Login successful', {
    user: user.toSafeJSON({ withPermissions: true }),
    country: await countryOf(user),
    accessToken,
    refreshToken,
  });
});

exports.refresh = catchAsync(async (req, res) => {
  const tokens = await authService.refreshTokens(req.body.refreshToken);
  return sendSuccess(res, 200, 'Token refreshed', tokens);
});

exports.logout = catchAsync(async (req, res) => {
  await authService.logout(req.user);
  return sendSuccess(res, 200, 'Logged out successfully');
});

exports.forgotPassword = catchAsync(async (req, res) => {
  const result = await authService.requestPasswordReset(req.body);
  // The reset link is emailed inside the service; the raw token is never returned in production.
  const data = process.env.NODE_ENV === 'production' || !result ? {} : { devOnlyResetToken: result.rawToken };
  return sendSuccess(res, 200, 'If that account exists, a reset link has been emailed', data);
});

exports.resetPassword = catchAsync(async (req, res) => {
  await authService.resetPassword(req.body);
  return sendSuccess(res, 200, 'Password reset successful');
});

exports.changePassword = catchAsync(async (req, res) => {
  await authService.changePassword(req.user, req.body);
  return sendSuccess(res, 200, 'Password changed successfully');
});

exports.setLanguage = catchAsync(async (req, res) => {
  const user = await authService.setLanguage(req.user, req.body.language);
  return sendSuccess(res, 200, 'Language updated', { user: user.toSafeJSON({ withPermissions: true }) });
});

exports.me = catchAsync(async (req, res) => {
  return sendSuccess(res, 200, 'Current user', { user: req.user.toSafeJSON({ withPermissions: true }), country: await countryOf(req.user) });
});
