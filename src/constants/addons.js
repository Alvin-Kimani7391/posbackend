/** Paid add-on ("premium feature") shapes + a starter catalogue seeded INACTIVE (nothing is locked until the admin switches it on). */
const ADDON_STATUSES = ['PENDING_PAYMENT', 'ACTIVE', 'CANCELLED', 'EXPIRED'];
const ADDON_KEY_RE = /^[a-z][a-z0-9_-]{1,39}$/;
const ADDON_CURRENCIES = ['KES', 'TZS'];
const ADDON_BILLING_TYPES = ['RECURRING', 'ONE_TIME']; // RECURRING = subscription (renews); ONE_TIME = pay once, keep it (no renewals)
const LIFETIME_MONTHS = 1200; // one-time purchases are stored as a 100-year period
const DEFAULT_GRACE_DAYS = 3;
const RENEWAL_LEAD_DAYS = 5;
const ABANDON_PENDING_DAYS = 7;
// PLACEHOLDER prices (cents): edit in Admin -> Premium features.
const DEFAULT_ADDONS = [
  { key: 'selfservice', name: 'Self-service kiosk', icon: 'kiosk', pages: ['hx-selfservice.html'], sortOrder: 10,
    tagline: 'Let customers order and pay themselves from a kiosk or their phone.',
    benefits: ['Shorter queues at the counter', 'Customers order and pay by M-PESA or cash', 'Orders flow straight to the kitchen'],
    prices: [{ currency: 'KES', amountCents: 150000 }, { currency: 'TZS', amountCents: 3000000 }] },
  { key: 'storefront', name: 'Online storefront', icon: 'globe', pages: ['hx-storefront.html'], sortOrder: 20,
    tagline: 'Your own online ordering page for delivery, pickup and bookings.',
    benefits: ['Shareable link and QR code', 'Delivery and pickup orders', 'Customers pay online'],
    prices: [{ currency: 'KES', amountCents: 200000 }, { currency: 'TZS', amountCents: 4000000 }] },
  { key: 'livetracking', name: 'Live tracking', icon: 'pin', pages: ['hx-live.html'], sortOrder: 30,
    tagline: 'Follow riders on a live map; customers track their own order.',
    benefits: ['Live rider map', 'Customer tracking link', 'Rider cash handover control'],
    prices: [{ currency: 'KES', amountCents: 150000 }, { currency: 'TZS', amountCents: 3000000 }] },
  { key: 'livetv', name: 'Live TV menu', icon: 'tv', pages: ['hx-tv.html'], sortOrder: 40,
    tagline: 'Show your menu and promotions on any TV, updated instantly.',
    benefits: ['Pair unlimited screens', 'Playlists and promotions', 'Publish and roll back in one tap'],
    prices: [{ currency: 'KES', amountCents: 100000 }, { currency: 'TZS', amountCents: 2000000 }] },
].map((a) => ({ ...a, businessTypes: ['restaurant'], intervalMonths: 1, trialDays: 0, graceDays: DEFAULT_GRACE_DAYS, isActive: false }));
module.exports = { ADDON_BILLING_TYPES, LIFETIME_MONTHS, ADDON_STATUSES, ADDON_KEY_RE, ADDON_CURRENCIES, DEFAULT_GRACE_DAYS, RENEWAL_LEAD_DAYS, ABANDON_PENDING_DAYS, DEFAULT_ADDONS };
