const Joi = require('joi');
const { TICKET_STATUSES, TICKET_PRIORITIES, TICKET_CATEGORIES } = require('../constants/ticket');

const objectId = Joi.string().hex().length(24);

exports.idParamSchema = Joi.object({ id: objectId.required() });

exports.createTicketSchema = Joi.object({
  subject: Joi.string().trim().min(3).max(150).required(),
  description: Joi.string().trim().min(10).max(3000).required(),
  category: Joi.string().valid(...TICKET_CATEGORIES).default('OTHER'),
  priority: Joi.string().valid(...TICKET_PRIORITIES).default('MEDIUM'),
  errorMessage: Joi.string().trim().allow('').max(5000),
  pageUrl: Joi.string().trim().allow('').max(500),
  branchId: objectId,
});

exports.replySchema = Joi.object({
  message: Joi.string().trim().min(1).max(3000).required(),
});

exports.listTicketsQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(15),
  status: Joi.string().valid(...TICKET_STATUSES).allow(''),
  search: Joi.string().trim().allow('').max(100),
});

/* ---- platform admin ---- */
exports.adminListQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(15),
  status: Joi.string().valid(...TICKET_STATUSES).allow(''),
  priority: Joi.string().valid(...TICKET_PRIORITIES).allow(''),
  businessId: objectId.allow(''),
  awaiting: Joi.string().valid('true', 'false').allow(''),
  search: Joi.string().trim().allow('').max(100),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
});

exports.adminStatusSchema = Joi.object({
  status: Joi.string().valid(...TICKET_STATUSES),
  priority: Joi.string().valid(...TICKET_PRIORITIES),
  resolution: Joi.string().trim().allow('').max(3000),
}).or('status', 'priority');
