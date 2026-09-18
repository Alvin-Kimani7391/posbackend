const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const authService = require('../services/auth.service');

const meta = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });

exports.register = catchAsync(async (req, res) => {
  const { business, user } = await authService.registerBusinessOwner(req.body);
  return sendSuccess(res, 201, 'Business and owner account created', {
    business,
    user: user.toSafeJSON(),
  });
});

exports.login = catchAsync(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.loginWithPassword(req.body, meta(req));
  return sendSuccess(res, 200, 'Login successful', {
    user: user.toSafeJSON(),
    accessToken,
    refreshToken,
  });
});

exports.pinLogin = catchAsync(async (req, res) => {
  const { user, accessToken, refreshToken } = await authService.loginWithPin(req.body, meta(req));
  return sendSuccess(res, 200, 'Login successful', {
    user: user.toSafeJSON(),
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
  // rawToken would be sent via SMS/email here; never returned to the client in production.
  const data = process.env.NODE_ENV === 'production' || !result ? {} : { devOnlyResetToken: result.rawToken };
  return sendSuccess(res, 200, 'If that account exists, a reset link has been sent', data);
});

exports.resetPassword = catchAsync(async (req, res) => {
  await authService.resetPassword(req.body);
  return sendSuccess(res, 200, 'Password reset successful');
});

exports.changePassword = catchAsync(async (req, res) => {
  await authService.changePassword(req.user, req.body);
  return sendSuccess(res, 200, 'Password changed successfully');
});

exports.me = catchAsync(async (req, res) => {
  return sendSuccess(res, 200, 'Current user', { user: req.user.toSafeJSON() });
});
