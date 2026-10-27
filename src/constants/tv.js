/** Live TV (digital menu board) constants. */
const SLIDE_TYPES = ['MENU_ITEMS', 'CATEGORY', 'PROMO', 'MEDIA', 'ROOMS', 'TEXT', 'ORDERS'];
// Live order status (optional slide / side panel). BOARD = Preparing | Ready columns, CARDS = one card per order with a progress bar,
// NOW_SERVING = huge ready numbers + small preparing list, MINIMAL = clean big-number list.
const ORDER_STYLES = ['BOARD', 'CARDS', 'NOW_SERVING', 'MINIMAL'];
const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY', 'DELIVERY', 'COUNTER', 'BAR_TAB', 'ROOM_SERVICE', 'PICKUP'];
const ORDER_PANEL_POSITIONS = ['RIGHT', 'LEFT', 'BOTTOM'];
const LAYOUTS = ['HERO', 'GRID', 'LIST', 'COMBO', 'SPLIT', 'FULLSCREEN', 'BANNER'];
const BADGES = ['NEW', 'BESTSELLER', 'HOT', 'SPICY', 'VEGAN', 'CHEFS_PICK', 'LIMITED'];
const TRANSITIONS = ['FADE', 'SLIDE', 'ZOOM', 'NONE'];
const THEMES = {
  BOLD_RED: { primary: '#C8102E', secondary: '#1B1B1B', accent: '#FFC72C', text: '#FFFFFF', background: '#121212' },
  FRESH_GREEN: { primary: '#1E8E3E', secondary: '#0F2A1A', accent: '#FFD23F', text: '#FFFFFF', background: '#0B1A12' },
  SUNSET: { primary: '#F2542D', secondary: '#2B1B17', accent: '#F5DFBB', text: '#FFFFFF', background: '#1A0F0C' },
  ELEGANT: { primary: '#B8935A', secondary: '#14110F', accent: '#E8D8B5', text: '#F5F0E6', background: '#0C0A09' },
  LIGHT: { primary: '#D62828', secondary: '#FFFFFF', accent: '#F77F00', text: '#1B1B1B', background: '#FAFAFA' },
};
const LIMITS = { SCREENS: 20, PLAYLISTS: 30, SLIDES: 40, ITEMS_PER_SLIDE: 12, SLIDE_SECONDS: { min: 4, max: 120 }, PAIR_MINUTES: 15, PAIR_ATTEMPTS: 8, OFFLINE_AFTER_SEC: 90, HISTORY: 25 };
const HEX = /^#[0-9a-fA-F]{6}$/;
module.exports = { ORDER_STYLES, ORDER_TYPES, ORDER_PANEL_POSITIONS, SLIDE_TYPES, LAYOUTS, BADGES, TRANSITIONS, THEMES, THEME_KEYS: Object.keys(THEMES), LIMITS, HEX };
