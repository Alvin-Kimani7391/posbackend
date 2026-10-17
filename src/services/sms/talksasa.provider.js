const axios = require('axios');

const BASE = String(process.env.TALKSASA_BASE_URL || 'https://bulksms.talksasa.com/api/v3').replace(/\/+$/, '');

/** One central TalkSasa account. The token never leaves the server. */
const isConfigured = () => !!String(process.env.TALKSASA_API_TOKEN || '').trim();

/**
 * Problems on OUR side (bad/expired token, TalkSasa balance used up). The shop did nothing wrong, so the queue keeps
 * such texts and retries them later instead of failing them; they go out as soon as the platform problem is fixed.
 */
const PLATFORM_RE = /insufficient|balance|low credit|not enough|unauthori[sz]ed|unauthenticated|invalid (api )?token|api token|token (is )?(invalid|expired)|account (is )?(suspended|inactive)/i;

async function sendSms({ to, senderId, message }) {
  const token = String(process.env.TALKSASA_API_TOKEN || '').trim();
  if (!token) return { ok: false, retry: false, platform: true, error: 'TALKSASA_API_TOKEN is not set on the server' };
  const recipient = String(to || '').replace(/\D/g, '');
  if (!recipient) return { ok: false, retry: false, error: 'Missing recipient phone number' };
  const sender = String(senderId || '').trim();
  if (!sender) return { ok: false, retry: false, error: 'Missing Sender ID' };

  try {
    const { data } = await axios.post(`${BASE}/sms/send`,
      { recipient, sender_id: sender, type: 'plain', message },
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 20000 });
    const body = data && typeof data === 'object' ? data : {};
    if (String(body.status || '').toLowerCase() === 'error') {
      const msg = String(body.message || 'Provider error').slice(0, 200);
      console.error('[sms] TalkSasa rejected message:', msg);
      return { ok: false, retry: false, platform: PLATFORM_RE.test(msg), error: msg };
    }
    const raw = body.data;
    const d = Array.isArray(raw) ? (raw[0] || {}) : (raw && typeof raw === 'object' ? raw : {});
    return { ok: true, providerMessageId: String(d.uid || d.id || d.message_id || body.uid || body.message_id || '') };
  } catch (err) {
    const status = err.response && err.response.status;
    const resp = err.response && err.response.data;
    const msg = String((resp && (resp.message || resp.error)) || err.message || 'Send failed').slice(0, 200);
    console.error('[sms] TalkSasa send failed', status || '', msg);
    const platform = status === 401 || status === 403 || PLATFORM_RE.test(msg);
    return { ok: false, retry: !status || status >= 500 || status === 429, platform, error: msg };
  }
}

module.exports = { sendSms, isConfigured };
