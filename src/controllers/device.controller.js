const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const deviceService = require('../services/device.service');

const secretOf = (req) => req.headers['x-device-secret'];

exports.list = catchAsync(async (req, res) => {
  const result = await deviceService.listDevices(req.businessId, req.query);
  return sendSuccess(res, 200, 'Devices fetched', result);
});

exports.enroll = catchAsync(async (req, res) => {
  const result = await deviceService.enrollDevice(req.businessId, req.user, req.body);
  res.set('Cache-Control', 'no-store'); // the response carries the one-time device secret
  return sendSuccess(res, 201, 'Device enrolled', result);
});

exports.update = catchAsync(async (req, res) => {
  const device = await deviceService.updateDevice(req.businessId, req.user, req.params.id, req.body);
  return sendSuccess(res, 200, 'Device updated', { device });
});

exports.revoke = catchAsync(async (req, res) => {
  const device = await deviceService.revokeDevice(req.businessId, req.user, req.params.id, req.body.reason);
  return sendSuccess(res, 200, 'Device blocked', { device });
});

exports.grant = catchAsync(async (req, res) => {
  const result = await deviceService.issueGrant(req.businessId, req.user, req.body.deviceId, secretOf(req));
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, 'Offline grant issued', result);
});

exports.heartbeat = catchAsync(async (req, res) => {
  const result = await deviceService.heartbeat(req.businessId, req.body.deviceId, secretOf(req), req.body);
  return sendSuccess(res, 200, 'OK', result);
});

exports.getPolicy = catchAsync(async (req, res) => {
  const policy = await deviceService.getOfflinePolicy(req.businessId);
  return sendSuccess(res, 200, 'Offline policy fetched', { policy });
});

exports.updatePolicy = catchAsync(async (req, res) => {
  const policy = await deviceService.updateOfflinePolicy(req.businessId, req.user, req.body);
  return sendSuccess(res, 200, 'Offline policy updated', { policy });
});


exports.setPin = catchAsync(async (req, res) => sendSuccess(res, 200, 'Offline PIN saved', await deviceService.setOfflinePin(req.businessId, req.user, req.body)));
exports.roster = catchAsync(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  return sendSuccess(res, 200, 'Roster issued', await deviceService.issueRoster(req.businessId, req.user, req.body.deviceId, secretOf(req)));
});