/**
 * Restaurant OPERATING PROFILE: the owner says which devices the restaurant has (waiter tablet, kitchen screen, kitchen / bar / till
 * printer, cashier station, self-service kiosk) and how paper is used. The rest of the system reads the resolved plan (ctx.ops).
 *
 * Changing it is always safe and can be done at any time: nothing is deleted, open orders keep working (see `settleOpenWork`).
 */
const RestaurantSettings = require('../../models/RestaurantSettings');
const RestaurantOrder = require('../../models/RestaurantOrder');
const Business = require('../../models/Business');
const ApiError = require('../../utils/ApiError');
const { PRESETS, PRESET_IDS, DEVICE_KEYS, DEFAULT_PRINTING, resolvePlan, planView } = require('../../constants/operations');
const prints = require('./print.service');
const C = require('./common');

const KITCHEN_OPEN = ['PENDING', 'ACCEPTED', 'PREPARING'];
const TARGET_NAME = { KITCHEN: 'kitchen printer', BAR: 'bar printer', CASHIER: 'till printer' };

const presetList = () => PRESET_IDS.map((id) => ({ id, label: PRESETS[id].label, summary: PRESETS[id].summary, devices: PRESETS[id].devices, printing: { ...DEFAULT_PRINTING, ...PRESETS[id].printing } }));
const stored = (settings) => { const o = settings.operations && settings.operations.toObject ? settings.operations.toObject() : (settings.operations || {}); return { configured: !!o.configured, preset: o.preset || 'CUSTOM', devices: o.devices || {}, printing: { ...DEFAULT_PRINTING, ...(o.printing || {}) }, ready: o.ready || {} }; };

/** Which physical printer prints what, so the owner knows what to switch on at each printer PC / tablet ("Auto-print on this device"). */
function printStations(plan) {
  if (!plan.configured) return [];
  const jobs = [];
  if (plan.print.kotOnSend) { jobs.push(['KITCHEN', plan.devices.barPrinter ? 'Kitchen tickets' : 'Kitchen and bar tickets']); if (plan.devices.barPrinter) jobs.push(['BAR', 'Bar tickets']); }
  if (plan.printsWaiterSlip) jobs.push(['WAITER', 'Waiter copy of each order']);
  if (plan.printsCancel) jobs.push(['KITCHEN', 'Cancellation slips']);
  jobs.push(['CASHIER', plan.printsBill ? 'Customer bills (automatic)' : 'Customer bills (when staff tap Print)']);
  jobs.push(['CASHIER', plan.printsReceipt ? 'Receipts (automatic)' : 'Receipts (guest M-PESA payments, or when staff tap Print)']);
  const by = new Map();
  for (const [role, label] of jobs) { const t = plan.route(role); if (!t) continue; if (!by.has(t)) by.set(t, []); by.get(t).push(label); }
  const WHERE = { KITCHEN: 'the PC or tablet next to the kitchen printer', BAR: 'the device next to the bar printer', CASHIER: 'the PC or tablet at the till / waiter station' };
  return [...by.entries()].map(([target, list]) => ({ target, printer: TARGET_NAME[target], choose: target, prints: [...new Set(list)], where: WHERE[target] }));
}

function warningsFor(plan, ctx, health) {
  const w = []; const add = (level, code, message) => w.push({ level, code, message });
  const d = plan.devices; const ss = ctx.settings.selfService || {}; const store = ctx.settings.storefront || {};
  if (!plan.configured) { add('info', 'NOT_SET_UP', 'The device set-up has not been saved yet. The system is using its default behaviour (kitchen screen if enabled; paper only for guest and self-service orders). Choose a set-up below to switch on kitchen tickets for waiter orders.'); return w; }
  if (!d.waiterTablet && !d.cashierStation && !d.selfServiceKiosk) add('warning', 'NO_ORDER_TAKER', 'No device is marked for taking orders. Tick "Waiter tablet" or "Cashier station" so staff know where orders are entered.');
  if (!plan.screen && !plan.route('KITCHEN')) add('warning', 'NO_KITCHEN_CHANNEL', 'The kitchen has no screen and no printer, so it will only hear about orders if someone tells it. Add a kitchen printer or a kitchen screen.');
  if (d.kitchenScreen && !ctx.features.kitchen) add('warning', 'KITCHEN_SCREEN_BLOCKED', 'The kitchen screen is ticked but is not available on this business plan, so orders are being handled as "no kitchen screen".');
  if (plan.printerCount === 1) add('info', 'SINGLE_PRINTER', `You have one printer (the ${TARGET_NAME[plan.singlePrinter]}). Everything prints there: kitchen tickets${plan.printsWaiterSlip ? ', the waiter copy' : ''}${plan.printsBill ? ', bills' : ''}${plan.printsReceipt ? ' and receipts' : ''}. Tear each slip off as it comes out.`);
  if (plan.print.waiterSlip && !plan.printsWaiterSlip) add('info', 'WAITER_SLIP_OFF', 'The waiter copy is switched on but nothing can print it (no printer, or kitchen tickets are off).');
  if (!plan.screen && plan.manualReadyTypes.length && store.enabled && store.delivery?.enabled !== false) add('info', 'MANUAL_READY', `Without a kitchen screen, ${plan.manualReadyTypes.map((t) => t.toLowerCase().replace('_', ' ')).join(', ')} orders must be marked READY by hand (cashier or waiter taps "Mark ready") before a rider can take them.`);
  if (d.selfServiceKiosk && !ss.enabled) add('warning', 'KIOSK_NOT_ENABLED', 'The kiosk is ticked but self-service is not switched on in the kiosk settings.');
  if (d.selfServiceKiosk && !ss.branchId) add('warning', 'KIOSK_NO_BRANCH', 'Choose the branch the kiosk sells for in the self-service settings.');
  if (d.selfServiceKiosk && ss.cash !== false && !d.cashierStation) add('warning', 'KIOSK_CASH_NO_CASHIER', 'The kiosk accepts cash but there is no cashier station to confirm it. Tick "Cashier station" or switch kiosk cash off.');
  if (d.selfServiceKiosk && !plan.route('CASHIER')) add('info', 'KIOSK_NO_PRINTER', 'No printer: the kiosk will show the customer their order number on screen and the cashier finds the order by that number.');
  for (const [target, h] of Object.entries(health || {})) if (h.oldestMinutes >= 2 && plan.printers[target]) add('warning', 'PRINTER_NOT_COLLECTING', `Paper has been waiting ${h.oldestMinutes} min for the ${TARGET_NAME[target]}. On the device next to it, open "Auto-print on this device", choose ${target}, and keep the page open.`);
  return w;
}

function channelsFor(plan, ctx) {
  const st = ctx.settings.storefront || {}; const kitchenHow = plan.screen ? (plan.printsKot('WAITER') ? 'on the kitchen screen and on paper' : 'on the kitchen screen') : plan.route('KITCHEN') ? `on paper at the ${TARGET_NAME[plan.route('KITCHEN')]}` : 'NOT AT ALL (add a printer or a screen)';
  return [
    { id: 'DINE_IN', label: 'Dine-in orders', available: plan.devices.waiterTablet || plan.devices.cashierStation || !plan.configured, takenBy: plan.orderTakers, kitchenSees: kitchenHow },
    { id: 'COUNTER', label: 'Counter / take-away', available: true, takenBy: plan.orderTakers.filter((x) => x !== 'KIOSK'), kitchenSees: kitchenHow, readyBy: plan.readyFor('COUNTER') },
    { id: 'DELIVERY', label: 'Online delivery', available: !!(st.enabled && st.delivery?.enabled !== false), works: plan.screen || !!plan.route('KITCHEN'), kitchenSees: kitchenHow, readyBy: plan.readyFor('DELIVERY'), note: plan.screen ? undefined : 'No kitchen screen needed: the kitchen ticket prints and staff tap "Mark ready" when the food is packed.' },
    { id: 'PICKUP', label: 'Pickup', available: true, kitchenSees: kitchenHow, readyBy: plan.readyFor('PICKUP') },
    { id: 'GUEST_QR', label: 'Guest QR ordering', available: !!ctx.features.guestQr, confirmedBy: plan.devices.waiterTablet ? 'waiter' : 'cashier', kitchenSees: kitchenHow },
    { id: 'KIOSK', label: 'Self-service kiosk', available: !!plan.devices.selfServiceKiosk, kitchenSees: kitchenHow, receiptPrinted: !!plan.route('CASHIER') },
  ];
}

/** Plain-language "how to run the restaurant with what you have" for the current set-up. */
function adviceFor(plan, ctx) {
  const d = plan.devices; const A = []; const sec = (title, steps) => steps.filter(Boolean).length && A.push({ title, steps: steps.filter(Boolean) });
  if (!plan.configured) return [{ title: 'Choose your set-up', steps: ['Pick the preset that matches the devices you have (waiter tablet, kitchen screen, printers, cashier only, kiosk) and save. You can change it any day.'] }];
  const kPrinter = plan.route('KITCHEN'); const tPrinter = plan.route('CASHIER');
  const taker = d.waiterTablet ? 'the waiter on the tablet' : d.cashierStation ? 'the cashier' : 'staff';
  sec('How an order flows', [
    `The order is entered by ${taker}${d.waiterTablet && d.cashierStation ? ' (the cashier can also enter counter orders)' : ''} and sent with the Send button.`,
    plan.screen ? 'The kitchen sees it on the kitchen screen and taps Accept / Preparing / Ready. The waiter is notified when food is ready.' : null,
    !plan.screen && kPrinter ? `The kitchen has no screen, so a ticket prints at the ${TARGET_NAME[kPrinter]}. The cook works from the paper.` : null,
    !plan.screen && !kPrinter ? 'There is no screen or printer for the kitchen: tell the kitchen verbally, or add a printer or screen.' : null,
    plan.screen && plan.printsKot('WAITER') ? 'A paper ticket also prints in the kitchen as a backup.' : null,
    plan.printsWaiterSlip ? `A second slip (the waiter copy${plan.print.slipPrices ? ', with prices' : ''}) prints${plan.printerCount === 1 ? ' on the same printer' : ` at the ${TARGET_NAME[plan.route('WAITER')]}`}. Keep it with the order or carry it to the table.` : null,
    !plan.screen ? 'Dine-in food counts as ready as soon as it is sent. When the kitchen calls, the waiter collects it and taps Served.' : null,
  ]);
  if (!plan.screen) sec('When the kitchen has no screen', [
    `For ${plan.manualReadyTypes.map((t) => t.toLowerCase().replace('_', ' ')).join(', ')} orders nobody walks the food out, so they stay "Preparing" until someone taps Mark ready on the order (the cashier or any waiter can).`,
    'If a ticket is lost or torn, open the order and tap Reprint kitchen ticket. A cancelled item prints a CANCELLED slip so the cook stops.',
    plan.print.cancelSlips ? null : 'Cancellation slips are off: tell the kitchen when you cancel something already sent.',
  ]);
  sec('Bills and payment', [
    tPrinter ? `Bills${plan.printsBill ? ' print automatically when generated' : ' print when you tap Print'} at the ${TARGET_NAME[tPrinter]}.` : 'There is no printer for bills: show the bill on the screen, or send it to the customer.',
    plan.printsReceipt ? 'The receipt prints automatically after payment.' : tPrinter ? 'Receipts print when you tap Print receipt.' : null,
    plan.printerCount === 1 ? 'Because there is one printer, kitchen tickets and customer bills share it. Keep it in a spot both the kitchen and the till can reach, or keep it in the kitchen and have staff carry bills.' : null,
    d.cashierStation ? 'The cashier station takes cash, M-PESA and card; open a cash shift before taking cash.' : 'Waiters take payment on the tablet, so each waiter opens a cash shift first.',
  ]);
  sec('Delivery and pickup', [
    plan.screen ? 'Online orders appear on the kitchen screen once they are paid (or confirmed for cash on delivery).' : (kPrinter ? `Online orders print at the ${TARGET_NAME[kPrinter]} as soon as they are paid or confirmed. No kitchen tablet is needed.` : 'Add a kitchen printer or screen so online orders reach the kitchen.'),
    !plan.screen ? 'When the food is packed, tap Mark ready on the order. Then assign a rider (or hand over for pickup).' : null,
    d.waiterTablet ? null : 'With no waiters, the cashier station confirms guest QR requests, assigns riders and marks orders ready.',
  ]);
  if (d.selfServiceKiosk) sec('Self-service kiosk', [
    'Customers choose and pay on the kiosk. M-PESA orders go straight to the kitchen.',
    'Cash: the customer takes the bill (or their order number) to the cashier. The kitchen sees the order only after the cashier confirms the money.',
    tPrinter ? 'The kiosk can print the bill / receipt on the till printer.' : 'There is no printer: the kiosk shows the order number and the customer reads it out to the cashier.',
  ]);
  const st = printStations(plan);
  if (st.length) sec('Setting up the printers', st.map((s) => `On ${s.where}: open "Auto-print on this device", choose ${s.choose}, and leave the page open. It prints: ${s.prints.join(', ')}.`).concat(['Use Chrome with --kiosk-printing on that device so paper prints without a dialog.']));
  return A;
}

async function snapshot(businessId, branchId) {
  const ctx = await C.getContext(businessId);
  const health = await prints.queueHealth(businessId, branchId);
  return { operations: stored(ctx.settings), plan: planView(ctx.ops), printStations: printStations(ctx.ops), channels: channelsFor(ctx.ops, ctx), warnings: warningsFor(ctx.ops, ctx, health), advice: adviceFor(ctx.ops, ctx), presets: presetList(), queue: health };
}

/** What every device (waiter, cashier, kitchen, kiosk) needs to know to show the right buttons. No settings permission needed. */
async function getPlan(businessId) { const ctx = await C.getContext(businessId); return planView(ctx.ops); }
async function get(businessId, user, { branchId } = {}) { if (branchId) C.assertBranchAccess(user, branchId); return snapshot(businessId, branchId); }

const merge = (base, patch) => { const out = { ...base }; for (const [k, v] of Object.entries(patch || {})) if (v !== undefined) out[k] = v; return out; };

/**
 * Orders already open when the devices change must not get stuck:
 *  - screen switched OFF: items waiting on the old kitchen screen can no longer be tapped there; staff mark them ready (markReady) - we only report how many.
 *  - screen switched ON : items sent while there was no screen (PREPARING, no ticket) get a kitchen ticket so the cooks can see them. No paper is printed for them.
 */
async function settleOpenWork(businessId, was, now) {
  const out = { openKitchenItemsToMarkByHand: 0, adoptedByKitchenScreen: 0 };
  if (was.screen && !now.screen) out.openKitchenItemsToMarkByHand = await RestaurantOrder.countDocuments({ businessId, status: 'OPEN', 'items.status': { $in: KITCHEN_OPEN } });
  if (!was.screen && now.screen) {
    const kitchen = require('./kitchen.service');
    const open = await RestaurantOrder.find({ businessId, status: 'OPEN', items: { $elemMatch: { status: { $in: KITCHEN_OPEN }, ticketId: { $exists: false } } } }).select('_id').limit(300);
    for (const o of open) {
      try {
        await C.inTx(async (session) => {
          const ctx = await C.getContext(businessId, session); const order = await C.loadOrder(businessId, o._id, session);
          const items = order.items.filter((i) => KITCHEN_OPEN.includes(i.status) && !i.ticketId); if (!items.length) return;
          await kitchen.createTickets(order, items, { type: 'NEW', ctx, session, silent: true }); await order.save({ session }); out.adoptedByKitchenScreen += items.length;
        });
      } catch (e) { console.error('[operations] could not adopt open order', String(o._id), e.message); }
    }
  }
  return out;
}

async function update(businessId, user, input) {
  const ctxBefore = await C.getContext(businessId);
  const { settings } = ctxBefore; const cur = stored(settings);
  let devices = {}; for (const k of DEVICE_KEYS) devices[k] = cur.devices[k] === true;
  let printing = { ...cur.printing }; let ready = { ...cur.ready };
  let preset = input.preset || cur.preset;
  let kioskTouched = false;
  if (input.preset && input.preset !== 'CUSTOM') { const p = PRESETS[input.preset]; devices = { ...p.devices }; printing = { ...DEFAULT_PRINTING, ...p.printing, paperWidthMm: printing.paperWidthMm || 80 }; kioskTouched = true; }
  if (input.devices) { devices = merge(devices, input.devices); if (input.devices.selfServiceKiosk !== undefined) kioskTouched = true; if (!input.preset) preset = 'CUSTOM'; }
  if (input.printing) printing = merge(printing, input.printing);
  if (input.ready) ready = merge(ready, input.ready);
  const notes = [];
  if (!(devices.kitchenPrinter || devices.barPrinter || devices.cashierPrinter)) {
    if (printing.kotOnSend || printing.waiterSlip || printing.billOnRequest || printing.receiptOnPayment || printing.cancelSlips) notes.push('No printer is ticked, so every paper option was switched off. Tick a printer to use them.');
    printing = { ...printing, kotOnSend: false, waiterSlip: false, billOnRequest: false, receiptOnPayment: false, cancelSlips: false };
  }

  const wasPlan = ctxBefore.ops;
  settings.operations = { configured: true, preset, devices, printing, ready: ready.manualOrderTypes ? { manualOrderTypes: ready.manualOrderTypes } : {}, updatedAt: new Date(), updatedBy: user._id };
  if (kioskTouched) settings.selfService.enabled = devices.selfServiceKiosk;      // the kiosk exists only when the owner says it does
  settings.markModified('operations');
  await settings.save();

  const $set = { 'featureSettings.kitchenDisplay': devices.kitchenScreen };      // the kitchen screen's routes (/kitchen/*) obey this flag
  if (input.useTables !== undefined) $set['featureSettings.tableManagement'] = !!input.useTables;
  if (input.guestQr !== undefined) $set['featureSettings.guestQrOrdering'] = !!input.guestQr;
  await Business.updateOne({ _id: businessId }, { $set });
  require('../../utils/businessContext').invalidateBusinessContext(businessId);

  const ctxAfter = await C.getContext(businessId);
  const settle = await settleOpenWork(businessId, wasPlan, ctxAfter.ops);
  await C.audit({ businessId, userId: user._id, action: 'restaurant.operations.update', entityType: 'RestaurantSettings', entityId: settings._id, oldValue: { preset: cur.preset, devices: cur.devices, printing: cur.printing }, newValue: { preset, devices, printing, ready } });
  const snap = await snapshot(businessId);
  if (settle.openKitchenItemsToMarkByHand) notes.push(`${settle.openKitchenItemsToMarkByHand} open order(s) still have food waiting on the old kitchen screen. Staff can tap Mark ready on them.`);
  if (settle.adoptedByKitchenScreen) notes.push(`${settle.adoptedByKitchenScreen} item(s) already in the kitchen now show on the kitchen screen.`);
  return { ...snap, notes, settle };
}

module.exports = { get, getPlan, update, presetList, printStations, warningsFor, adviceFor, channelsFor, resolvePlan };
