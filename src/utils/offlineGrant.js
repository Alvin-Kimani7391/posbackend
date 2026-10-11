'use strict';
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/**
 * Offline grant = a signed statement "user X, on device Y, in branch Z, may sell offline until T,
 * with THESE limits". The till uses it to decide what is allowed; every offline sale carries it;
 * the server verifies the signature at sync, so nobody can forge sales as another cashier and the
 * checks use the permissions the cashier had AT THE TIME of the sale, not today's.
 *
 * It uses its OWN secret (OFFLINE_GRANT_SECRET), never the access-token secret.
 */
function getSecret() {
  const s = process.env.OFFLINE_GRANT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('OFFLINE_GRANT_SECRET must be set to a random string of at least 32 characters');
  }
  return s;
}

function signOfflineGrant(claims, expiresInSeconds) {
  return jwt.sign({ ...claims, typ: 'offline-grant' }, getSecret(), {
    algorithm: 'HS256',
    expiresIn: expiresInSeconds,
    jwtid: crypto.randomUUID(),
  });
}

/**
 * Verifies signature ONLY. Expiry is deliberately ignored here: a grant is expected to be
 * "expired" by the time the sale syncs. The ingest code must instead compare each sale's
 * soldAt against payload.offlineUntil and flag sales made after it.
 */
function verifyOfflineGrant(token) {
  const payload = jwt.verify(token, getSecret(), { algorithms: ['HS256'], ignoreExpiration: true });
  if (payload.typ !== 'offline-grant') throw new Error('Not an offline grant');
  return payload;
}

module.exports = { signOfflineGrant, verifyOfflineGrant };