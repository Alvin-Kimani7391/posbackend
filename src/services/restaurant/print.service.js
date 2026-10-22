/**
 * Print queue. Kitchen / bar tickets for guest (QR) orders and paid receipts are queued here; a staff device switched to
 * "auto-print" (js/core/hx-autoprint.js) collects the jobs for its station and prints them. Nothing here ever throws into an order or payment.
 */
const PrintJob = require('../../models/PrintJob');
const KitchenStation = require('../../models/KitchenStation');
const C = require('./common');

const TARGETS = ['KITCHEN', 'BAR', 'CASHIER'];
const hhmm = (d, tz) => { try { return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || 'Africa/Nairobi' }); } catch (e) { return ''; } };

/** One paper ticket for one station. Called inside the order transaction (session) right after tickets are created. */
async function enqueueKot(order, tickets, { session, tz } = {}) {
  try {
    if (!['QR_TABLE', 'QR_ROOM', 'KIOSK'].includes(order.source)) return;
    for (const t of tickets) {
      if (!t.items || !t.items.length) continue;
      let type = 'KITCHEN';
      if (t.stationId) { const st = await KitchenStation.findById(t.stationId).select('type').session(session || null); if (st && st.type === 'BAR') type = 'BAR'; }
      const place = order.tableName ? `Table ${order.tableName}` : order.roomNumber ? `Room ${order.roomNumber}` : order.orderType;
      const doc = {
        title: `${type === 'BAR' ? 'Bar' : 'Kitchen'} order`, big: true,
        highlight: { label: place, value: t.ticketNumber },
        meta: [['Order', order.orderNumber], ['Source', order.source === 'KIOSK' ? 'Self-service (PAID)' : order.source === 'QR_ROOM' ? 'Guest phone (room)' : 'Guest phone (table)'], ['Guest', order.customerName], ['Waiter', order.waiterName], ['Time', hhmm(Date.now(), tz)], ['Type', t.type !== 'NEW' ? t.type : '']],
        lines: t.items.filter((i) => !i.cancelled).map((i) => ({ qty: i.quantity, name: i.name + (i.variantName ? ` (${i.variantName})` : ''), sub: [i.modifiersText, i.notes && `NOTE: ${i.notes}`, i.allergyNotes && `ALLERGY: ${i.allergyNotes}`].filter(Boolean).join(' | ') })),
        footer: t.allergyAlert ? '*** ALLERGY ALERT ***' : '',
      };
      await PrintJob.create([{ businessId: order.businessId, branchId: order.branchId, target: type, kind: 'KOT', title: `${place} ${t.ticketNumber}`, doc, refId: t._id }], session ? { session } : {});
    }
  } catch (e) { console.error('[print] could not queue kitchen ticket:', e.message); }
}

/** One paid receipt per bill: the guest-payment path and the cashier dashboard may both ask, the second request is a no-op. `force` = an explicit reprint. */
async function enqueueReceipt(businessId, branchId, doc, refId, title, { force = false } = {}) {
  try {
    if (!force && refId && await PrintJob.exists({ businessId, target: 'CASHIER', kind: 'RECEIPT', refId, title: /^Receipt / })) return;
    await PrintJob.create({ businessId, branchId, target: 'CASHIER', kind: 'RECEIPT', title, doc, refId });
  } catch (e) { console.error('[print] could not queue receipt:', e.message); }
}

/** Staff device asks for work. Claims atomically so two devices never print the same ticket; a claim not confirmed in 60 s is offered again. */
async function claim(businessId, user, { targets, branchId, limit = 5 }) {
  C.assertBranchAccess(user, branchId);
  if (!C.can(user, 'restaurant.kitchen.view') && !C.can(user, 'restaurant.bills.view')) throw require('../../utils/ApiError').forbidden('Printing needs permission', 'FORBIDDEN');
  const want = String(targets || '').split(',').filter((t) => TARGETS.includes(t));
  if (!want.length) return [];
  const out = [];
  for (let i = 0; i < Math.min(+limit || 5, 10); i += 1) {
    const stale = new Date(Date.now() - 60000);
    const j = await PrintJob.findOneAndUpdate({ businessId, branchId, target: { $in: want }, $or: [{ status: 'PENDING' }, { status: 'CLAIMED', claimedAt: { $lt: stale } }] }, { $set: { status: 'CLAIMED', claimedAt: new Date() } }, { sort: { createdAt: 1 }, new: true });
    if (!j) break; out.push(j);
  }
  return out;
}
async function ack(businessId, user, id) {
  const j = await PrintJob.findOneAndUpdate({ _id: id, businessId }, { $set: { status: 'PRINTED', printedAt: new Date() } }, { new: true });
  return { id, status: j ? j.status : 'GONE' };
}
module.exports = { enqueueKot, enqueueReceipt, claim, ack, TARGETS };
