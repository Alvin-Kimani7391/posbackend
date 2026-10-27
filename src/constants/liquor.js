/** Wines & spirits module constants. Legal limits (minimum age, hours, dry days) are only DEFAULTS: the owner must set them to what their county / TRA / regulator requires. */
const CATEGORIES = ['WINE', 'SPARKLING', 'WHISKY', 'VODKA', 'GIN', 'RUM', 'BRANDY', 'TEQUILA', 'LIQUEUR', 'BEER', 'CIDER', 'RTD', 'TRADITIONAL', 'OTHER_SPIRIT', 'SOFT_DRINK', 'MIXER', 'SNACK', 'OTHER'];
const ALCOHOL_CATEGORIES = ['WINE', 'SPARKLING', 'WHISKY', 'VODKA', 'GIN', 'RUM', 'BRANDY', 'TEQUILA', 'LIQUEUR', 'BEER', 'CIDER', 'RTD', 'TRADITIONAL', 'OTHER_SPIRIT'];
const DEFAULT_MIN_AGE = { KE: 18, TZ: 18 };
const AGE_MODES = ['CONFIRM', 'ID_REQUIRED']; // CONFIRM: cashier attests the buyer is of age. ID_REQUIRED: ID type + last 4 digits (or date of birth) must be entered.
const ID_TYPES = ['NATIONAL_ID', 'PASSPORT', 'DRIVING_LICENCE', 'MILITARY_ID', 'OTHER'];
const EMPTIES_MODES = ['OFF', 'TRACK', 'ENFORCE']; // ENFORCE: the deposit charged on the sale must equal (bottles sold - empties returned) x deposit
const CONTAINER_KINDS = ['BOTTLE', 'CRATE', 'KEG', 'OTHER'];
const MOVEMENT_TYPES = ['SOLD_OUT', 'RETURNED_IN', 'REFUND_PAID', 'SUPPLIER_RECEIVED', 'SUPPLIER_RETURNED', 'ADJUST', 'REVERSAL'];
const TOT_COUNT_TYPES = ['COUNT', 'WASTE', 'COMP'];
module.exports = { CATEGORIES, ALCOHOL_CATEGORIES, DEFAULT_MIN_AGE, AGE_MODES, ID_TYPES, EMPTIES_MODES, CONTAINER_KINDS, MOVEMENT_TYPES, TOT_COUNT_TYPES };
