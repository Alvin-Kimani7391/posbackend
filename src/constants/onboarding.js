/**
 * Setup-guide (onboarding) step keys. The frontend decides WHICH steps exist for a business
 * (some depend on the business type); the backend only stores the owner's manual choices so
 * progress survives across devices and "resume later" works.
 *
 * A step is stored only when the owner marks it by hand ("Mark as done" / "Skip for now").
 * Steps that can be detected from real data (branches, employees, products...) are detected by
 * the frontend and never need a stored row.
 */
const ONBOARDING_STEP_KEYS = [
  'type',          // chose / confirmed the business type
  'branches',
  'employees',
  'products',
  'labels',        // printed the shelf price list / labels
  'inventory',
  'registers',
  'shifts',
  'settings',
  // type-specific extras (shown only when the matching feature is on)
  'batches',
  'serials',
  'warranty',
  'repairs',
  'vehicles',
  'jobcards',
  'stocktake',
];

const ONBOARDING_STEP_STATUSES = ['done', 'skipped'];

module.exports = { ONBOARDING_STEP_KEYS, ONBOARDING_STEP_STATUSES };
