'use strict';
const crypto = require('crypto');
const env = require('../config/env');

/** Random, unguessable secret printed in a receipt's QR code (18 random bytes = 144 bits, 24 URL-safe chars). */
const newVerifyToken = () => crypto.randomBytes(18).toString('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const isValidToken = (t) => typeof t === 'string' && TOKEN_RE.test(t);

/** Link printed inside the QR: <web app>/verify.html?t=<token>. VERIFY_BASE_URL wins, then FRONTEND_URL. */
function verifyUrl(token) {
  if (!token) return '';
  let base = env.verifyBaseUrl || env.frontendUrl || '';
  if (!base || base === '*') return '';
  base = String(base).split(',')[0].trim().replace(/\/+$/, '');
  return `${base}/verify.html?t=${encodeURIComponent(token)}`;
}
module.exports = { newVerifyToken, isValidToken, verifyUrl };
