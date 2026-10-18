/**
 * Single source of truth for business types and feature flags.
 * Used by: models/Business.js, validators, auth/business services, requireFeature middleware.
 *
 * Flags only CONFIGURE behaviour. Each flag must be backed by real models, APIs and permissions
 * before it is enabled for customers (see docs/business-requirements/).
 */

const BUSINESS_TYPES = [
  'supermarket', 'electronics', 'clothing', 'hardware', 'cosmetics',
  'restaurant', 'general_shop', 'wholesale', 'garage', 'pharmacy', 'other',
];

const FEATURE_KEYS = [
  'expiryTracking',
  'batchTracking',
  'productVariants',
  'serialNumberTracking',
  'warrantyManagement',
  'repairManagement',
  'unitConversions',
  'quotationManagement',
  'deliveryManagement',
  'customerCredit',
  'loyaltyProgram',
  'tableManagement',
  'kitchenDisplay',
  'recipeManagement',
  'restaurantOrdering', // master switch for the restaurant module (tables / kitchen / recipes / reservations are optional add-ons)
  'reservations',
  'guestQrOrdering',  // QR codes on tables and rooms: guests view the menu, order and call a waiter
  'accommodation',    // rooms, check-in / check-out, folios (restaurants that also offer rooms)
  'vehicleManagement',
  'jobCards',
  'wholesalePricing',
  'multiWarehouse',
  'layaway',
  'tradeIn',
  // pharmacy
  'pharmacyDispensing',
  'prescriptionManagement',
  'restrictedProductControl',
  'recallManagement',
  'quarantineManagement',
];

// Features that must never be switched on/off freely by the owner for a given type.
// (e.g. a pharmacy cannot turn off batch tracking or quarantine.)
const LOCKED_ON = {
  pharmacy: ['expiryTracking', 'batchTracking', 'quarantineManagement', 'recallManagement'],
};

const BUSINESS_FEATURE_DEFAULTS = {
  supermarket: { expiryTracking: true, batchTracking: true, unitConversions: true, loyaltyProgram: true },
  electronics: { serialNumberTracking: true, warrantyManagement: true, repairManagement: true, layaway: true, tradeIn: true },
  clothing: { productVariants: true, loyaltyProgram: true, layaway: true },
  hardware: { unitConversions: true, quotationManagement: true, deliveryManagement: true },
  cosmetics: {
    expiryTracking: true, batchTracking: true, productVariants: true, loyaltyProgram: true,
    quarantineManagement: true, recallManagement: true,
  },
  restaurant: {
    restaurantOrdering: true, tableManagement: true, kitchenDisplay: true, recipeManagement: true,
    reservations: true, batchTracking: true, guestQrOrdering: true,
  },
  general_shop: { layaway: true },
  wholesale: {
    wholesalePricing: true, unitConversions: true, quotationManagement: true,
    deliveryManagement: true, multiWarehouse: true, customerCredit: true,
  },
  garage: { vehicleManagement: true, jobCards: true, quotationManagement: true },
  pharmacy: {
    expiryTracking: true, batchTracking: true, pharmacyDispensing: true,
    prescriptionManagement: true, restrictedProductControl: true,
    recallManagement: true, quarantineManagement: true,
  },
  other: {},
};

/** Defaults for a type, as a full {key: boolean} object. */
function defaultsFor(type) {
  const on = BUSINESS_FEATURE_DEFAULTS[type] || {};
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, !!on[k]]));
}

/**
 * Merge a type's defaults with explicit overrides. Locked-on features stay on.
 * `current` (existing settings) wins over defaults so nothing the owner enabled is lost.
 */
function resolveFeatures(type, current = {}, overrides = {}) {
  const out = { ...defaultsFor(type) };
  for (const k of FEATURE_KEYS) {
    if (typeof current[k] === 'boolean' && current[k]) out[k] = true; // keep what was enabled
    if (typeof overrides[k] === 'boolean') out[k] = overrides[k];
  }
  for (const k of LOCKED_ON[type] || []) out[k] = true;
  return out;
}

module.exports = {
  BUSINESS_TYPES, FEATURE_KEYS, BUSINESS_FEATURE_DEFAULTS, LOCKED_ON,
  defaultsFor, resolveFeatures,
};