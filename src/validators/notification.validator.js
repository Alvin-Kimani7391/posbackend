const Joi = require('joi');
const { EMPLOYEE_RAISABLE_TYPES } = require('../constants/notificationTypes');

const idParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
});

const listNotificationsQuery = Joi.object({
  unreadOnly: Joi.boolean().truthy('true').falsy('false'),
  type: Joi.string(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});

const raiseAlertSchema = Joi.object({
  branchId: Joi.string().hex().length(24),
  type: Joi.string().valid(...EMPLOYEE_RAISABLE_TYPES).required(),
  message: Joi.string().min(3).max(500).required(),
  data: Joi.object().unknown(true),
});

module.exports = { idParamSchema, listNotificationsQuery, raiseAlertSchema };