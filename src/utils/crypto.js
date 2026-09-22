const crypto = require('crypto');

// AES-256-GCM. INTEGRATION_ENCRYPTION_KEY must be a 32-byte key, base64-encoded,
// e.g. generated once with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Rotate by re-encrypting on read+rewrite if you ever need to change it - never
// change it in place without a migration, or every stored credential breaks.
const KEY = Buffer.from(process.env.INTEGRATION_ENCRYPTION_KEY || '', 'base64');

if (KEY.length !== 32 && process.env.NODE_ENV !== 'test') {
  // Fail loudly at boot rather than silently storing garbage/unencrypted secrets.
  throw new Error('INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
}

function encrypt(plainObjectOrString) {
  const plaintext = typeof plainObjectOrString === 'string' ? plainObjectOrString : JSON.stringify(plainObjectOrString);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as one opaque base64 blob: iv || authTag || ciphertext
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(blobBase64) {
  if (!blobBase64) return null;
  const buf = Buffer.from(blobBase64, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext;
}

function decryptJson(blobBase64) {
  const raw = decrypt(blobBase64);
  return raw ? JSON.parse(raw) : null;
}

/** Never send this back to a browser - only a boolean "is something stored". */
function maskedHint(blobBase64) {
  return { isSet: !!blobBase64 };
}

module.exports = { encrypt, decrypt, decryptJson, maskedHint };