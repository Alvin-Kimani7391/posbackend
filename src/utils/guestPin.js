/** Reversible storage for the guest-room PIN, so the guest card can be reprinted. The hash in Stay.guestPinHash is what is checked. */
const crypto = require('crypto');
const key = () => crypto.createHash('sha256').update(`guest-pin:${process.env.QR_SECRET || require('../config/env').jwt.secret}`).digest();
function encrypt(pin) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(pin), 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
function decrypt(blob) {
  try {
    const [iv, tag, enc] = String(blob || '').split('.'); if (!iv || !tag || !enc) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  } catch (e) { return null; }
}
module.exports = { encrypt, decrypt };
