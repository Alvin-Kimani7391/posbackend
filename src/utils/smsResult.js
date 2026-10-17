/** Turns an alerts.service result into something a till screen can show. */
const REASONS = {
  DISABLED: 'SMS alerts for "ready for collection" are switched off in settings.',
  BAD_PHONE: 'The customer phone number is not a valid Kenyan mobile number.',
  DUPLICATE: 'A message was already sent to this customer in the last hour.',
  OPTED_OUT: 'The customer has opted out of SMS.',
  NO_SENDER_ID: 'No Sender ID is available yet. Please contact support, or apply for your own under SMS settings.',
  ALERTS_PAUSED: 'SMS alerts are temporarily paused by the platform. Please try again later.',
  RATE_LIMIT: 'Too many test texts. Please try again in an hour.',
  NO_OWNER: 'No active owner with a valid phone number was found.',
  NOTHING: 'Nothing to report right now.',
  NO_CREDITS: 'Not enough SMS credits. Top up to send.',
  NOT_READY: 'The item is not ready yet.',
  NOT_FOUND: 'Job not found.',
  NO_BUSINESS: 'Business not found.',
  ERROR: 'The message could not be queued. Please try again.',
};

function smsResult(r) {
  if (r && r.queued) return { sent: true, credits: r.segments, message: 'The customer will receive an SMS shortly.' };
  const code = (r && r.skipped) || 'ERROR';
  return { sent: false, reason: code, message: REASONS[code] || REASONS.ERROR };
}

module.exports = { smsResult, REASONS };