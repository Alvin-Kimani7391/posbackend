// Maps Safaricom's STK ResultCode (passed through by PayHero's callback
// as-is) to a machine-readable `type` and a short, cashier-facing message.
// Single source of truth - the raw ResultDesc from Safaricom is never shown
// to a cashier as-is (it's logged internally on MpesaTransaction.resultDesc
// for debugging, but the UI always shows this table's `message`).

const MPESA_RESULT_CODES = {
  0:    { type: 'success',            message: 'Payment completed successfully.' },
  1:    { type: 'insufficient_funds', message: 'Insufficient M-Pesa balance. Ask the customer to top up and try again.' },
  1032: { type: 'cancelled',          message: 'Customer cancelled the M-Pesa prompt before entering their PIN.' },
  1037: { type: 'timeout',            message: 'Customer did not respond to the prompt in time.' },
  2001: { type: 'wrong_pin',          message: 'Wrong M-Pesa PIN entered. Ask the customer to try again with the correct PIN.' },
  1001: { type: 'in_progress',        message: 'Customer already has an M-Pesa request in progress. Ask them to finish or cancel it first.' },
  9999: { type: 'system_error',       message: 'M-Pesa could not process this right now. Please try again shortly.' },
};

function interpretMpesaResult(resultCode, resultDesc) {
  const code = Number(resultCode);
  const known = MPESA_RESULT_CODES[code];
  if (known) return { code, ...known };
  return {
    code: Number.isFinite(code) ? code : null,
    type: 'failed',
    message: resultDesc && String(resultDesc).trim() ? `Payment failed: ${resultDesc}` : 'Payment could not be completed. Please try again.',
  };
}

/** For the "STK push itself couldn't be sent" case (network/auth/rate-limit) - distinct from a Safaricom result code, since no phone prompt ever appeared. */
function interpretInitiateError(err) {
  const status = err.response?.status;
  const body = err.response?.data;
  const raw = (body?.error_message || body?.message || '').toLowerCase();

  if (status === 401 || status === 403 || raw.includes('unauthor') || raw.includes('invalid credential')) {
    return { type: 'bad_credentials', message: 'M-PESA is not configured correctly for this business. Contact the owner.' };
  }
  if (status === 429 || raw.includes('restrict')) {
    return { type: 'rate_limited', message: 'Too many M-PESA requests recently - PayHero has temporarily throttled this account. Try again shortly, or take a manual payment.' };
  }
  if (raw.includes('insufficient') && raw.includes('wallet')) {
    return { type: 'wallet_empty', message: 'Your PayHero service wallet is empty. Top it up to keep sending STK pushes.' };
  }
  return { type: 'send_failed', message: 'Could not reach M-Pesa right now. Please try again, or take cash/card instead.' };
}

module.exports = { interpretMpesaResult, interpretInitiateError, MPESA_RESULT_CODES };