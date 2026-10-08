const axios = require('axios');

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/**
 * Sends a transactional email through Brevo. NEVER throws - billing must never fail because an email did.
 * env: BREVO_API_KEY, BREVO_SENDER_EMAIL (a verified sender in Brevo), BREVO_SENDER_NAME
 */
async function sendEmail({ to, subject, html, text, tags }) {
  const seen = new Set();
  const recipients = (to || [])
    .filter((r) => r && r.email)
    .map((r) => ({ email: String(r.email).trim().toLowerCase(), name: r.name || undefined }))
    .filter((r) => (seen.has(r.email) ? false : seen.add(r.email)));

  if (!recipients.length) return { ok: false, skipped: 'no_recipients' };
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    console.warn('[email] BREVO_API_KEY / BREVO_SENDER_EMAIL not set - email skipped:', subject);
    return { ok: false, skipped: 'not_configured' };
  }

  try {
    const res = await axios.post(
      BREVO_URL,
      {
        sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Six Star POS' },
        to: recipients,
        subject,
        htmlContent: html,
        textContent: text || undefined,
        tags: tags || undefined,
      },
      { headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, timeout: 15000 }
    );
    return { ok: true, messageId: res.data?.messageId, count: recipients.length };
  } catch (err) {
    console.error('[email] Brevo send failed', { status: err.response?.status, body: err.response?.data }); // never log the key
    return { ok: false, error: err.response?.data?.message || err.message };
  }
}

module.exports = { sendEmail };