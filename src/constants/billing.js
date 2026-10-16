// Platform subscriptions are billed in the business's own currency. KES businesses pay through PayHero STK or a
// pasted M-PESA message; TZS businesses pay by mobile money / bank transfer to the platform's Tanzanian number and
// the payment is verified by a platform admin (no STK integration exists for Tanzania).
const BILLING_CURRENCIES = ['KES', 'TZS'];
const DEFAULT_BILLING_CURRENCY = 'KES';
const PLAN_KEY_BY_CURRENCY = { KES: 'standard', TZS: 'standard-tz' };
const MANUAL_MAX_CENTS_BY_CURRENCY = { KES: 100000000, TZS: 2000000000 }; // KES 1,000,000 / TZS 20,000,000
const STK_CURRENCIES = ['KES'];

module.exports = {
  BILLING_CURRENCIES, DEFAULT_BILLING_CURRENCY, PLAN_KEY_BY_CURRENCY, MANUAL_MAX_CENTS_BY_CURRENCY, STK_CURRENCIES,
  PHASE_TYPES: ['TRIAL', 'INSTALLMENTS', 'RECURRING'],
  PRICING_MODES: ['FLAT', 'TIERED'],
  TIER_METRICS: ['TRANSACTION_COUNT', 'SALES_VALUE'],
  SUBSCRIPTION_STATUSES: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'],
  INVOICE_STATUSES: ['PENDING', 'PARTIAL', 'PAID', 'VOID'],
  INVOICE_KINDS: ['INSTALLMENT', 'RECURRING', 'ONE_OFF'],
  PAYMENT_METHODS: ['STK', 'MPESA_MANUAL', 'CASH', 'BANK', 'OTHER'],
  PAYMENT_STATUSES: ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'REJECTED', 'CANCELLED'],
  // Keeps the existing Business.subscriptionStatus field (used by the admin lists) in sync.
  BUSINESS_STATUS_MAP: { TRIALING: 'trialing', ACTIVE: 'active', PAST_DUE: 'past_due', SUSPENDED: 'suspended', CANCELLED: 'cancelled' },
  LIMITS: {
    STK_MIN_CENTS: 100,
    STK_MAX_CENTS: 15000000, // KES 150,000 (M-PESA STK ceiling)
    MANUAL_MAX_CENTS: 100000000,
    MAX_PENDING_MANUAL: 5,
    STK_TIMEOUT_MS: 90 * 1000,
    LATE_SUCCESS_WINDOW_MS: 24 * 3600 * 1000,
  },
};