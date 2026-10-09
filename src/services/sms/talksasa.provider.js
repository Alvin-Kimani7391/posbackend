const axios = require('axios');

const BASE = process.env.TALKSASA_BASE_URL || 'https://bulksms.talksasa.com/api/v3';

/** One central TalkSasa account. The token never leaves the server. VERIFY endpoint/fields against TalkSasa docs before launch. */
async function sendSms({ to, senderId, message }) {
  const token = process.env.TALKSASA_API_TOKEN;
  if (!token) return { ok: false, retry: false, error: 'TALKSASA_API_TOKEN not set' };
  try {
    const { data } = await axios.post(`${BASE}/sms/send`,
      { recipient: to, sender_id: senderId, type: 'plain', message },
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 20000 });
    if (String(data.status).toLowerCase() === 'error') return { ok: false, retry: false, error: data.message || 'Provider error' };
    const d = data.data || {};
    return { ok: true, providerMessageId: String(d.uid || d.id || d.message_id || '') };
  } catch (err) {
    const status = err.response && err.response.status;
    const msg = (err.response && err.response.data && (err.response.data.message || err.response.data.error)) || err.message;
    console.error('[sms] TalkSasa send failed', status, msg);
    return { ok: false, retry: !status || status >= 500 || status === 429, error: String(msg).slice(0, 200) };
  }
}

module.exports = { sendSms };