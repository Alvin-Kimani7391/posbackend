/**
 * Restaurant OPERATING PROFILE: which devices a restaurant really has, and how the system must behave because of that.
 *
 * Nothing in here touches the database. `resolvePlan(settings, features)` turns the owner's stored profile into one small object
 * ("the plan") that every service asks: where does paper go, does a kitchen screen exist, who marks food ready, ...
 *
 * A business that never opens the setup page has `operations.configured = false` and gets EXACTLY the behaviour it had before
 * (kitchen screen if the feature flag is on, paper only for guest QR / kiosk orders).
 */
const { ORDER_TYPES } = require('./restaurant');

/** Devices the owner can have. Every flag can be changed at any time; nothing is deleted when one is switched off. */
const DEVICE_KEYS = [
  'waiterTablet',      // waiters take orders on a tablet / phone
  'kitchenScreen',     // a kitchen display (KDS) the cooks tap on
  'kitchenPrinter',    // a receipt printer in the kitchen
  'barPrinter',        // a separate receipt printer at the bar (bar tickets go to the kitchen printer when there is none)
  'cashierPrinter',    // the receipt printer at the till / waiter station: customer bills and receipts
  'cashierStation',    // a cashier tablet or PC that takes payments (and, with no waiters, the orders)
  'selfServiceKiosk',  // a customer self-service tablet
];

const PRESET_IDS = [
  'WAITER_KITCHEN_PRINTER_ONLY',   // waiter tablet + ONE printer, in the kitchen
  'WAITER_AND_KITCHEN_PRINTERS',   // waiter tablet + printer at the till + printer in the kitchen, no kitchen screen
  'WAITER_KITCHEN_SCREEN',         // waiter tablet + kitchen screen, no printers
  'FULL_HYBRID',                   // waiter tablet + kitchen screen + kitchen printer + till printer
  'CASHIER_ONLY',                  // only a cashier tablet / PC and ONE receipt printer
  'CASHIER_KITCHEN_SCREEN',        // cashier takes orders, kitchen has a screen
  'SELF_SERVICE',                  // customers order on a kiosk, cashier confirms cash, kitchen has a screen
  'SELF_SERVICE_NO_PRINTER',       // kiosk, cashier, kitchen screen, nobody has a printer
  'CUSTOM',
];

const off = { waiterTablet: false, kitchenScreen: false, kitchenPrinter: false, barPrinter: false, cashierPrinter: false, cashierStation: false, selfServiceKiosk: false };

/**
 * `printing` defaults per preset. Booleans are plain choices the owner can flip afterwards.
 *  kotOnSend      print a kitchen ticket whenever an order (or add-on) is sent
 *  kotCopies      how many kitchen tickets per send (1-3)
 *  waiterSlip     a SECOND slip "waiter copy" on every send (what was ordered, to carry to the table or pin to the order)
 *  slipPrices     show prices on that waiter slip
 *  billOnRequest  print the customer bill when a bill is generated
 *  receiptOnPayment print the receipt when a bill is paid by staff (guest M-PESA receipts always print when a printer exists)
 *  receiptCopies  1-3
 *  cancelSlips    print a "CANCELLED" slip when something already sent is cancelled
 */
const PRESETS = {
  WAITER_KITCHEN_PRINTER_ONLY: {
    label: 'Waiter tablet, one printer in the kitchen',
    summary: 'Waiters take orders on a tablet. The only printer is in the kitchen: it prints the kitchen ticket and a waiter copy.',
    devices: { ...off, waiterTablet: true, kitchenPrinter: true },
    printing: { kotOnSend: true, kotCopies: 1, waiterSlip: true, slipPrices: false, billOnRequest: true, receiptOnPayment: false, receiptCopies: 1, cancelSlips: true },
  },
  WAITER_AND_KITCHEN_PRINTERS: {
    label: 'Waiter tablet, printer at the till and in the kitchen',
    summary: 'Waiters use a tablet. The kitchen has no screen and learns about orders from its printer. Bills and receipts print at the till.',
    devices: { ...off, waiterTablet: true, kitchenPrinter: true, cashierPrinter: true, cashierStation: true },
    printing: { kotOnSend: true, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: true, receiptOnPayment: true, receiptCopies: 1, cancelSlips: true },
  },
  WAITER_KITCHEN_SCREEN: {
    label: 'Waiter tablet and kitchen screen, no printers',
    summary: 'Everything is on screens: the kitchen taps items as they are cooked and the waiter sees them ready. Bills are shown on the tablet.',
    devices: { ...off, waiterTablet: true, kitchenScreen: true },
    printing: { kotOnSend: false, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: false, receiptOnPayment: false, receiptCopies: 1, cancelSlips: false },
  },
  FULL_HYBRID: {
    label: 'Waiter tablet, kitchen screen and printers',
    summary: 'The complete set-up: tablets and screens, plus paper in the kitchen and at the till as a backup and for bills.',
    devices: { ...off, waiterTablet: true, kitchenScreen: true, kitchenPrinter: true, cashierPrinter: true, cashierStation: true },
    printing: { kotOnSend: true, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: true, receiptOnPayment: true, receiptCopies: 1, cancelSlips: true },
  },
  CASHIER_ONLY: {
    label: 'Cashier station only, one printer',
    summary: 'No waiters and no kitchen device. The cashier takes the order; the single printer prints a kitchen ticket and a customer/waiter copy, and later the bill.',
    devices: { ...off, cashierStation: true, cashierPrinter: true },
    printing: { kotOnSend: true, kotCopies: 1, waiterSlip: true, slipPrices: true, billOnRequest: true, receiptOnPayment: true, receiptCopies: 1, cancelSlips: true },
  },
  CASHIER_KITCHEN_SCREEN: {
    label: 'Cashier station with a kitchen screen',
    summary: 'The cashier takes orders and payments; the kitchen works from a screen. One printer at the till for bills and receipts.',
    devices: { ...off, cashierStation: true, cashierPrinter: true, kitchenScreen: true },
    printing: { kotOnSend: false, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: true, receiptOnPayment: true, receiptCopies: 1, cancelSlips: false },
  },
  SELF_SERVICE: {
    label: 'Self-service kiosk with cashier and kitchen screen',
    summary: 'Customers order on a kiosk. Cash orders are confirmed by the cashier; M-PESA orders go straight to the kitchen screen.',
    devices: { ...off, selfServiceKiosk: true, cashierStation: true, cashierPrinter: true, kitchenScreen: true },
    printing: { kotOnSend: false, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: false, receiptOnPayment: true, receiptCopies: 1, cancelSlips: false },
  },
  SELF_SERVICE_NO_PRINTER: {
    label: 'Self-service kiosk, no printers',
    summary: 'Customers order on a kiosk and are shown their order number on screen. The cashier finds the order by number; the kitchen works from a screen.',
    devices: { ...off, selfServiceKiosk: true, cashierStation: true, kitchenScreen: true },
    printing: { kotOnSend: false, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: false, receiptOnPayment: false, receiptCopies: 1, cancelSlips: false },
  },
  CUSTOM: {
    label: 'Custom',
    summary: 'Choose each device yourself.',
    devices: { ...off },
    printing: { kotOnSend: true, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: true, receiptOnPayment: false, receiptCopies: 1, cancelSlips: true },
  },
};

/** With no kitchen screen nobody can tap "ready". Dine-in food is assumed ready when the waiter collects it; these order types must be marked ready by hand. */
const DEFAULT_MANUAL_READY_TYPES = ['DELIVERY', 'PICKUP', 'TAKEAWAY', 'COUNTER'];

const PRINT_ROLES = ['KITCHEN', 'BAR', 'CASHIER', 'WAITER'];
const PHYSICAL = ['KITCHEN', 'BAR', 'CASHIER'];

const DEFAULT_PRINTING = { kotOnSend: true, kotCopies: 1, waiterSlip: false, slipPrices: false, billOnRequest: true, receiptOnPayment: false, receiptCopies: 1, cancelSlips: true, paperWidthMm: 80 };

const plain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : (v || {}));

/**
 * @param settings  RestaurantSettings document (or plain object)
 * @param features  { kitchen: boolean } from the business feature flags (kitchenDisplay)
 */
function resolvePlan(settings, features = {}) {
  const ops = plain(settings && settings.operations);
  const configured = ops.configured === true;
  const d = plain(ops.devices);
  const devices = {};
  for (const k of DEVICE_KEYS) devices[k] = configured ? d[k] === true : false;
  if (!configured) { devices.kitchenScreen = !!features.kitchen; devices.waiterTablet = true; devices.cashierStation = true; }

  const screen = !!features.kitchen && (configured ? devices.kitchenScreen : true);
  const printers = configured
    ? { KITCHEN: devices.kitchenPrinter, BAR: devices.barPrinter, CASHIER: devices.cashierPrinter }
    : { KITCHEN: true, BAR: true, CASHIER: true };          // legacy: a device that chose "auto-print" collects whatever is queued
  const printerCount = PHYSICAL.filter((p) => printers[p]).length;
  const hasPrinter = configured ? printerCount > 0 : true;

  const pr = { ...DEFAULT_PRINTING, ...plain(ops.printing) };
  const manualTypes = Array.isArray(ops.ready && ops.ready.manualOrderTypes) && ops.ready.manualOrderTypes.length ? ops.ready.manualOrderTypes : DEFAULT_MANUAL_READY_TYPES;

  /** Which physical printer prints a paper of this role. null = the restaurant has no printer for it (nothing is queued, nothing fails). */
  function route(role) {
    if (!configured) return role === 'WAITER' ? 'CASHIER' : role;
    if (role === 'KITCHEN') return printers.KITCHEN ? 'KITCHEN' : printers.CASHIER ? 'CASHIER' : printers.BAR ? 'BAR' : null;
    if (role === 'BAR') return printers.BAR ? 'BAR' : printers.KITCHEN ? 'KITCHEN' : printers.CASHIER ? 'CASHIER' : null;
    return printers.CASHIER ? 'CASHIER' : printers.KITCHEN ? 'KITCHEN' : printers.BAR ? 'BAR' : null;      // CASHIER, WAITER
  }

  /** Does an order from this source print a kitchen ticket? Unconfigured businesses keep the old rule (guest orders only). */
  function printsKot(source) {
    if (!configured) return ['QR_TABLE', 'QR_ROOM', 'KIOSK'].includes(source);
    return pr.kotOnSend === true && route('KITCHEN') !== null;
  }
  const printsWaiterSlip = configured && pr.waiterSlip === true && route('WAITER') !== null && pr.kotOnSend === true;
  const printsBill = configured && pr.billOnRequest === true && route('CASHIER') !== null;
  const printsReceipt = configured && pr.receiptOnPayment === true && route('CASHIER') !== null;
  const printsCancel = configured ? pr.cancelSlips === true && route('KITCHEN') !== null && pr.kotOnSend === true : false;

  /** SCREEN: the kitchen taps it. AUTO: ready the moment it is sent. MANUAL: staff mark it ready by hand. */
  function readyFor(orderType) {
    if (screen) return 'SCREEN';
    if (!configured) return 'AUTO';
    return manualTypes.includes(orderType) ? 'MANUAL' : 'AUTO';
  }

  const kitchenMode = screen ? (hasPrinter && configured && printsKot('WAITER') ? 'SCREEN_AND_PRINT' : 'SCREEN') : (configured && printsKot('WAITER') ? 'PRINT_ONLY' : 'NONE');
  // Who can take an order at the counter: a waiter tablet, or (when there are no waiters) the cashier station.
  const orderTakers = [devices.waiterTablet && 'WAITER', (devices.cashierStation || !devices.waiterTablet) && 'CASHIER', devices.selfServiceKiosk && 'KIOSK'].filter(Boolean);

  return {
    configured, preset: ops.preset || 'CUSTOM', devices, screen, kitchenMode, orderTakers,
    printers, printerCount, singlePrinter: configured && printerCount === 1 ? PHYSICAL.find((p) => printers[p]) : null,
    print: { ...pr, kotCopies: Math.min(3, Math.max(1, +pr.kotCopies || 1)), receiptCopies: Math.min(3, Math.max(1, +pr.receiptCopies || 1)) },
    manualReadyTypes: manualTypes,
    route, printsKot, printsWaiterSlip, printsBill, printsReceipt, printsCancel, readyFor,
  };
}

/** The part of the plan that is safe and useful to send to a screen. */
function planView(plan) {
  return {
    configured: plan.configured, preset: plan.preset, devices: plan.devices, kitchenMode: plan.kitchenMode, kitchenScreen: plan.screen, orderTakers: plan.orderTakers,
    printers: plan.printers, singlePrinter: plan.singlePrinter,
    printing: { ...plan.print, kitchenTicketAt: plan.route('KITCHEN'), billAt: plan.route('CASHIER'), waiterSlipAt: plan.route('WAITER'), barTicketAt: plan.route('BAR') },
    markReadyByHand: plan.screen ? [] : plan.manualReadyTypes,
  };
}

module.exports = { DEVICE_KEYS, PRESET_IDS, PRESETS, DEFAULT_MANUAL_READY_TYPES, DEFAULT_PRINTING, PRINT_ROLES, PHYSICAL, ORDER_TYPES, resolvePlan, planView };
