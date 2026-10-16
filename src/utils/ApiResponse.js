const { successMessage } = require('../i18n');

function sendSuccess(res, statusCode, message, data = {}) {
  // res.req.lang is set by middleware/language.js (+ authenticate); English messages pass through untouched.
  const lang = res.req && res.req.lang;
  return res.status(statusCode).json({
    success: true,
    message: lang ? successMessage(lang, message) : message,
    data,
  });
}

module.exports = { sendSuccess };
