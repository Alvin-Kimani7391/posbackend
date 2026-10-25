const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const manager = require('../services/manager/manager.service');
module.exports = {
  overview: catchAsync(async (req, res) => sendSuccess(res, 200, 'Manager overview fetched', await manager.overview(req.businessId, req.user, req.query))),
};