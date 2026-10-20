/**
 * Everything the guest's phone does after the QR scan beyond ordering: see the bill, pay it with an M-PESA STK push, get the
 * e-receipt, charge it to the room, see stay details and the accommodation deals. The money side is finished on the SERVER
 * (finalize), so a guest who closes the page after entering their M-PESA PIN is still billed correctly and the staff still see it.
 */
const RestaurantOrder = require('../../models/RestaurantOrder');
const RestaurantBill = require('../../models/RestaurantBill');
const MpesaTransaction = require('../../models/MpesaTransaction');
const IntegrationSettings = require('../../models/IntegrationSettings');
const RoomType = require('../../models/RoomType');
const GuestReceipt = require('../../models/GuestReceipt');
const Stay = require('../../models/Stay');
const ApiError = require('../../utils/ApiError');
const B = require('../../utils/restaurantBilling');
const T = require('../../utils/hospitalityTime');
const mpesa = require('../mpesa.service');
const bills = require('../restaurant/bill.service');
const prints = require('../restaurant/print.service');
const stays = require('./stay.service');
const folio = require('./folio.service');
const calls = require('./servicecall.service');
const C = require('./common');
const G = require('./guest.service');

const money = (c) => (c === null || c === undefined ? null : Math.round(c) / 100);
const PHONE = /^(?:\+?254|0)?[17]\d{8}$/;
const plain = (i) => i.toObject({ transform: false, virtuals: false });

async function mpesaOn(businessId) {
  const s = await IntegrationSettings.findOne({ businessId }).select('mpesa.enabled mpesa.channelId');
  return !!(s && s.mpesa && s.mpesa.enabled && s.mpesa.channelId);
}
const placeOrders = (r) => {
  const businessId = r.doc.businessId;
  if (r.kind === 'TABLE') return RestaurantOrder.find({ businessId, tableId: r.doc._id, status: 'OPEN', orderType: 'DINE_IN' }).sort({ createdAt: 1 });
  if (!r.stay) return [];
  return RestaurantOrder.find({ businessId, stayId: r.stay._id, orderType: 'ROOM_SERVICE', status: 'OPEN' }).sort({ createdAt: 1 });
};
const lineView = (l) => ({ name: [l.name, l.variantName && `(${l.variantName})`].filter(Boolean).join(' '), note: l.modifiersText, quantity: l.quantity, total: money(l.total), comp: !!l.isComp });
const billView = (b) => ({ id: b._id, number: b.billNumber, label: b.label, status: b.status, lines: b.lines.map(lineView), itemsTotal: money(b.itemsTotal), discount: money(b.discount), serviceCharge: money(b.serviceCharge), tax: money(b.tax), total: money(b.total), paid: money(b.paid), balance: money(b.balance), receiptNumber: b.receiptNumber });

// ------------------------------------------------------------------ bill
async function billView_(token, { pin }) {
  const r = await G.place(token, { pin, needPin: true });
  const { ctx, doc } = r; const out = [];
  for (const o of await placeOrders(r)) {
    const existing = await RestaurantBill.find({ orderId: o._id, status: { $ne: 'VOID' } }).sort({ createdAt: 1 });
    const billed = new Map();
    for (const b of existing) for (const l of b.lines) billed.set(String(l.orderItemId), (billed.get(String(l.orderItemId)) || 0) + l.quantity);
    const lines = [];
    for (const it of o.items) { if (!B.isBillable(it)) continue; const left = B.round4(it.quantity - (billed.get(String(it._id)) || 0)); if (left > 1e-9) lines.push(B.buildLine({ ...plain(it), quantity: left }, ctx.taxInclusive)); }
    let unbilled = null;
    if (lines.length) { const sc = C.scConfig(ctx.settings, o.orderType); const t = B.billTotals(lines, { scPercent: sc.scPercent, scTaxRate: sc.scTaxRate, scWaived: false }); unbilled = { lines: lines.map(lineView), serviceCharge: money(t.serviceCharge), tax: money(t.tax), total: money(t.total) }; }
    const items = o.items.filter((i) => !['CANCELLED', 'DRAFT', 'HELD'].includes(i.status) && !i.parentItemId);
    out.push({ orderId: o._id, orderNumber: o.orderNumber, served: items.length > 0 && items.every((i) => i.status === 'SERVED'), bills: existing.map(billView), unbilled });
  }
  const mp = await mpesaOn(doc.businessId);
  return { currency: ctx.business.currency, place: G.label(r), kind: r.kind, orders: out, mpesa: mp, canChargeRoom: r.kind === 'ROOM' && !!r.stay && ctx.acc.roomService.enabled, showPrices: ctx.settings.guestOrdering?.showPrices !== false };
}

// ------------------------------------------------------------------ pay by STK push
async function payStart(token, { pin, phone, orderId, billId, kind = 'BILL', accountId }) {
  const r = await G.place(token, { pin, needPin: true, needStay: kind === 'STAY' });
  const { doc } = r; const businessId = doc.businessId;
  const digits = String(phone || '').replace(/[\s-]/g, '');
  if (!PHONE.test(digits)) throw ApiError.badRequest('Enter a valid Safaricom number, for example 0712 345 678', 'INVALID_PHONE');
  if (!(await mpesaOn(businessId))) throw ApiError.badRequest('Paying from your phone is not set up here. Please ask a waiter.', 'MPESA_NOT_ENABLED');
  const actor = await C.guestActor(businessId);
  let ref; let amount; let branchId; let customerName; let orderRef;
  if (kind === 'STAY') {
    const s = await Stay.findById(r.stay._id); folio.recompute(s);
    if (!(s.totals.balance > 0)) throw ApiError.conflict('Nothing is owing on your room account.', 'NOTHING_TO_PAY');
    ref = s._id; amount = s.totals.balance; branchId = s.branchId; customerName = s.guest.name;
  } else {
    const order = (await placeOrders(r)).find((o) => String(o._id) === String(orderId)); if (!order) throw ApiError.notFound('That order is no longer open.', 'ORDER_NOT_FOUND');
    try { await bills.generateBill(businessId, actor, order._id, {}); } catch (e) { if (!/NOTHING_TO_BILL/.test(e.code || e.message || '')) throw e; }
    const open = await RestaurantBill.find({ orderId: order._id, status: { $in: ['OPEN', 'PARTIAL'] } }).sort({ createdAt: 1 });
    const bill = billId ? open.find((b) => String(b._id) === String(billId)) : open[0];
    if (!bill || !(bill.balance > 0)) throw ApiError.conflict('There is nothing to pay on this order yet.', 'NOTHING_TO_PAY');
    ref = bill._id; amount = bill.balance; branchId = bill.branchId; customerName = order.customerName || 'Guest'; orderRef = order._id;
  }
  const again = await MpesaTransaction.findOne({ businessId, 'guestPay.refId': ref, status: 'PENDING', createdAt: { $gt: new Date(Date.now() - 90000) } });
  if (again && again.amount === amount) return { reference: again.reference, amount: money(amount), reused: true };
  const txn = await mpesa.initiateStk(businessId, branchId, actor, { phone: digits, amountCents: amount, customerName });
  await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { guestPay: { kind, refId: ref, orderId: orderRef, placeKey: String(doc._id), placeLabel: G.label(r), accountId, tries: 0 } } });
  return { reference: txn.reference, amount: money(amount) };
}

async function payStatus(token, { pin, reference }) {
  const r = await G.place(token, { pin, needPin: true });
  const businessId = r.doc.businessId;
  const txn = await MpesaTransaction.findOne({ businessId, reference });
  if (!txn || !txn.guestPay || txn.guestPay.placeKey !== String(r.doc._id)) throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  const st = await mpesa.getStatus(businessId, reference);
  const res = { status: st.status, message: st.message, amount: money(txn.amount), mpesaReceipt: st.mpesaReceiptNumber || null, failureType: st.failureType || null };
  if (st.status === 'SUCCESS') { const f = await finalize(txn._id); res.settled = !!f.settled; res.problem = f.error ? true : undefined; }
  return res;
}

/** Records a confirmed M-PESA payment against the bill / stay, exactly once, however many places call it (page poll, M-PESA callback, sweep). */
async function finalize(txnId) {
  const stale = new Date(Date.now() - 60000);
  const txn = await MpesaTransaction.findOneAndUpdate(
    { _id: txnId, status: 'SUCCESS', 'guestPay.kind': { $in: ['BILL', 'STAY'] }, 'guestPay.settledAt': null, $or: [{ 'guestPay.settleStartedAt': null }, { 'guestPay.settleStartedAt': { $lt: stale } }] },
    { $set: { 'guestPay.settleStartedAt': new Date() }, $inc: { 'guestPay.tries': 1 } }, { new: true });
  if (!txn) { const t = await MpesaTransaction.findById(txnId); return { settled: !!(t && t.guestPay && t.guestPay.settledAt) }; }
  const g = txn.guestPay; const businessId = txn.businessId; const actor = await C.guestActor(businessId);
  let placeText = '';
  try {
    const ctx = await C.getAccContext(businessId);
    const payment = [{ method: 'MPESA', amount: txn.amount, reference: txn.reference }];
    if (g.kind === 'BILL') {
      const bill = await RestaurantBill.findOne({ _id: g.refId, businessId });
      if (!txn.restaurantBillId) await bills.pay(businessId, actor, g.refId, { payments: payment });
      const done = await RestaurantBill.findOne({ _id: g.refId, businessId });
      placeText = done.tableName ? `Table ${done.tableName}` : `Room (${done.orderNumber})`;
      if (done.status === 'PAID') await prints.enqueueReceipt(businessId, done.branchId, receiptDoc(done, ctx, txn), done._id, `Receipt ${done.receiptNumber || done.billNumber}`);
      const text = { type: 'GUEST_PAYMENT', title: `${placeText} paid ${fmt(ctx, txn.amount)}`, message: `M-PESA ${txn.mpesaReceiptNumber || txn.reference} - bill ${done.billNumber}${done.status === 'PAID' ? ' is fully paid.' : ` part paid, ${fmt(ctx, done.balance)} left.`}`, branchId: done.branchId, entityType: 'RestaurantBill', entityId: done._id };
      if (bill && bill.waiterId) C.notifyUser(businessId, bill.waiterId, text);
      C.notifyRoles(businessId, done.branchId, [...C.CASHIER_ROLES, ...C.FLOOR_LEAD_ROLES], text); C.notifyManagement(businessId, text);
    } else {
      const stay = await Stay.findOne({ _id: g.refId, businessId });
      if (!txn.stayId) await folio.addPayment(businessId, actor, g.refId, { kind: 'PAYMENT', ...payment[0] });
      const text = { type: 'GUEST_PAYMENT', title: `Room ${stay.roomNumber} paid ${fmt(ctx, txn.amount)}`, message: `M-PESA ${txn.mpesaReceiptNumber || txn.reference} towards ${stay.stayNumber}.`, branchId: stay.branchId, entityType: 'Stay', entityId: stay._id };
      C.notifyRoles(businessId, stay.branchId, ['RECEPTIONIST', ...C.CASHIER_ROLES], text); C.notifyManagement(businessId, text);
    }
    await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { 'guestPay.settledAt': new Date() }, $unset: { 'guestPay.error': 1 } });
    await saveCopy(txn, ctx);
    return { settled: true };
  } catch (e) {
    console.error('[guest pay] could not record payment', txn.reference, e.message);
    await MpesaTransaction.updateOne({ _id: txn._id }, { $set: { 'guestPay.error': String(e.message).slice(0, 200) } });
    if ((g.tries || 0) + 1 >= 3) C.notifyManagement(businessId, { type: 'GUEST_PAYMENT_PROBLEM', title: 'A guest paid by M-PESA but the bill was not closed', message: `${txn.mpesaReceiptNumber || txn.reference} (${txn.amount / 100}) was received but could not be applied: ${e.message}. Please settle the bill by hand.`, entityType: 'MpesaTransaction', entityId: txn._id });
    return { settled: false, error: e.message };
  }
}
const fmt = (ctx, cents) => `${ctx.business.currency || 'KES'} ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const finalizeByTxn = (id) => finalize(id).catch((e) => console.error('[guest pay] finalize failed:', e.message));

/** Safety net: finishes guest payments whose phone went away, and polls STK pushes still waiting. */
async function sweep() {
  const since = new Date(Date.now() - 3 * 3600000);
  const todo = await MpesaTransaction.find({ 'guestPay.kind': { $in: ['BILL', 'STAY'] }, 'guestPay.settledAt': null, createdAt: { $gt: since }, 'guestPay.tries': { $lt: 6 }, status: { $in: ['SUCCESS', 'PENDING'] } }).limit(50);
  for (const t of todo) {
    try { if (t.status === 'PENDING') { if (Date.now() - t.createdAt.getTime() > 5 * 60000) continue; await mpesa.getStatus(t.businessId, t.reference); } await finalize(t._id); } catch (e) { /* next round */ }
  }
}

function receiptDoc(bill, ctx, txn) {
  const b = ctx.business; const rs = b.receiptSettings || {};
  return {
    business: { name: b.name, address: b.address, phone: b.phone, pin: b.kraPin || b.taxPin },
    title: 'Receipt',
    meta: [['Receipt', bill.receiptNumber], ['Bill', bill.billNumber], [bill.tableName ? 'Table' : 'Order', bill.tableName || bill.orderNumber], ['Date', new Date(bill.settledAt || Date.now()).toLocaleString('en-KE', { timeZone: ctx.timeZone })], ['M-PESA', txn && txn.mpesaReceiptNumber]],
    lines: bill.lines.filter((l) => !l.isComp).map((l) => ({ qty: l.quantity, name: [l.name, l.variantName && `(${l.variantName})`].filter(Boolean).join(' '), sub: l.modifiersText, total: money(l.total) })),
    totals: [['Items', fmtN(bill.itemsTotal)], bill.discount ? ['Discount', '-' + fmtN(bill.discount)] : null, bill.serviceCharge ? ['Service charge', fmtN(bill.serviceCharge)] : null, bill.tax ? ['VAT included', fmtN(bill.tax)] : null, ['TOTAL', fmtN(bill.total), true], ['Paid', fmtN(bill.paid)]].filter(Boolean),
    payments: bill.payments.filter((p) => p.kind === 'PAYMENT').map((p) => ({ label: p.method === 'MPESA' ? 'M-PESA' : p.method, value: fmtN(p.amount), sub: p.reference })),
    footer: rs.footerMessage || 'Thank you for dining with us!',
  };
}
const fmtN = (c) => (Math.round(c) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ------------------------------------------------------------------ e-receipt
async function receipt(token, { pin, reference }) {
  const r = await G.place(token, { pin, needPin: true });
  const businessId = r.doc.businessId; const ctx = r.ctx;
  const txn = await MpesaTransaction.findOne({ businessId, reference });
  if (!txn || !txn.guestPay || txn.guestPay.placeKey !== String(r.doc._id)) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
  const saved = await GuestReceipt.findOne({ businessId, reference }); if (saved) return saved.snapshot;     // the electronic copy never changes
  return buildReceipt(txn, ctx, G.label(r));
}
/** Keeps the electronic copy of a paid bill, for the guest's account and for this phone. */
async function saveCopy(txn, ctx) {
  try {
    const g = txn.guestPay; g.settledAt = g.settledAt || new Date(); const rc = await buildReceipt(txn, ctx, g.placeLabel || '');
    await GuestReceipt.updateOne({ businessId: txn.businessId, reference: txn.reference }, { $setOnInsert: { businessId: txn.businessId, reference: txn.reference, accountId: g.accountId, placeKey: g.placeKey, kind: g.kind, number: rc.number, total: rc.total, paidAmount: rc.paidAmount, paid: rc.paid, snapshot: rc } }, { upsert: true });
  } catch (e) { console.error('[guest pay] could not save receipt copy:', e.message); }
}
async function buildReceipt(txn, ctx, placeLabel) {
  const businessId = txn.businessId; const r = { _placeLabel: placeLabel };
  const b = ctx.business; const rs = b.receiptSettings || {};
  const head = { currency: b.currency, business: { name: b.name, address: b.address, phone: b.phone, taxPin: b.kraPin || b.taxPin, logo: rs.showLogo ? b.logo : undefined }, place: placeLabel, mpesaReceipt: txn.mpesaReceiptNumber || null, phone: txn.phone, footer: rs.footerMessage || 'Thank you!' };
  if (txn.guestPay.kind === 'STAY') {
    const s = await Stay.findById(txn.guestPay.refId); if (!s) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
    return { ...head, kind: 'STAY', paid: !!txn.guestPay.settledAt, number: txn.mpesaReceiptNumber || txn.reference, date: txn.updatedAt, title: 'Payment receipt', lines: [{ name: `Payment towards room account ${s.stayNumber}`, quantity: 1, total: money(txn.amount) }], total: money(txn.amount), paidAmount: money(txn.amount), balance: null };
  }
  const bill = await RestaurantBill.findOne({ _id: txn.guestPay.refId, businessId }); if (!bill) throw ApiError.notFound('Receipt not found', 'RECEIPT_NOT_FOUND');
  return { ...head, kind: 'BILL', paid: bill.status === 'PAID', number: bill.receiptNumber || bill.billNumber, billNumber: bill.billNumber, date: bill.settledAt || txn.updatedAt, title: bill.status === 'PAID' ? 'Receipt' : 'Part payment receipt',
    lines: bill.lines.filter((l) => !l.isComp).map(lineView), itemsTotal: money(bill.itemsTotal), discount: money(bill.discount), serviceCharge: money(bill.serviceCharge), tax: money(bill.tax), total: money(bill.total), paidAmount: money(bill.paid), balance: money(bill.balance),
    payments: bill.payments.filter((p) => p.kind === 'PAYMENT').map((p) => ({ method: p.method === 'MPESA' ? 'M-PESA' : p.method, amount: money(p.amount), reference: p.reference })) };
}

// ------------------------------------------------------------------ charge to room
async function chargeToRoom(token, { pin, orderId, billId }) {
  const r = await G.place(token, { pin, needPin: true, needStay: true });
  if (r.kind !== 'ROOM' || !r.ctx.acc.roomService.enabled) throw ApiError.badRequest('Charging to the room is not available here.', 'ROOM_CHARGE_DISABLED');
  const businessId = r.doc.businessId; const actor = await C.guestActor(businessId);
  const order = (await placeOrders(r)).find((o) => String(o._id) === String(orderId)); if (!order) throw ApiError.notFound('That order is no longer open.', 'ORDER_NOT_FOUND');
  try { await bills.generateBill(businessId, actor, order._id, {}); } catch (e) { if (!/NOTHING_TO_BILL/.test(e.code || e.message || '')) throw e; }
  const open = await RestaurantBill.find({ orderId: order._id, status: 'OPEN' }).sort({ createdAt: 1 });
  const bill = billId ? open.find((b) => String(b._id) === String(billId)) : open[0];
  if (!bill || !(bill.balance > 0)) throw ApiError.conflict('There is nothing to charge on this order.', 'NOTHING_TO_PAY');
  const out = await bills.pay(businessId, actor, bill._id, { payments: [{ method: 'ROOM', amount: bill.balance, stayId: r.stay._id }] });
  const text = { type: 'GUEST_PAYMENT', title: `Room ${r.doc.number} charged ${fmt(r.ctx, bill.balance)}`, message: `${bill.orderNumber} was charged to the guest's room account.`, branchId: bill.branchId, entityType: 'RestaurantBill', entityId: bill._id };
  C.notifyRoles(businessId, bill.branchId, ['RECEPTIONIST', ...C.CASHIER_ROLES], text);
  return { charged: true, billNumber: out.bill.billNumber, total: money(bill.balance), message: 'Added to your room account. You will settle it when you check out.' };
}

// ------------------------------------------------------------------ stay details (room)
async function stayView(token, { pin }) {
  const r = await G.place(token, { pin, needStay: true, needPin: true });
  const s = await Stay.findById(r.stay._id); folio.recompute(s);
  const rt = s.roomTypeId ? await RoomType.findById(s.roomTypeId).select('name images amenities bedConfig description') : null;
  const ss = r.ctx.acc.selfService; const rsv = r.ctx.acc.roomService;
  return {
    currency: r.ctx.business.currency, stayNumber: s.stayNumber, bookingCode: s.bookingCode, guest: { name: s.guest.name, phone: s.guest.phone },
    room: { number: r.doc.number, floor: r.doc.floor, type: rt && rt.name, bedConfig: rt && rt.bedConfig, amenities: (rt && rt.amenities) || [], images: (rt && rt.images) || [], description: rt && rt.description },
    checkInDate: s.checkInDate, checkOutDate: s.checkOutDate, checkInTime: s.policy && s.policy.checkInTime, checkOutTime: s.policy && s.policy.checkOutTime, expectedCheckOut: s.expectedCheckOut, nights: s.nights, adults: s.adults, children: s.children, mealPlan: s.mealPlan, specialRequests: s.specialRequests,
    lines: s.folio.filter((l) => !l.voided).map((l) => ({ description: l.description, quantity: l.quantity, total: money(l.total), date: l.postedAt, type: l.type })),
    payments: s.payments.filter((p) => p.kind !== 'REFUND').map((p) => ({ method: p.method, kind: p.kind, amount: money(p.amount), at: p.at })),
    charges: money(s.totals.charges), paid: money(s.totals.paid), balance: money(s.totals.balance),
    selfCheckOut: !!ss.selfCheckOut, checkoutRequested: !!s.checkoutRequestedAt, roomService: { enabled: !!rsv.enabled, hours: rsv.hoursStart ? `${rsv.hoursStart} - ${rsv.hoursEnd}` : null }, mpesa: await mpesaOn(r.doc.businessId),
  };
}

// ------------------------------------------------------------------ deals
async function deals(token) {
  const r = await require('./qr.service').resolve(token);
  const { ctx, doc } = r; const empty = { available: false, rooms: [] };
  if (!ctx.features.accommodation) return empty;
  const today = T.todayIn(ctx.timeZone); const actor = await C.guestActor(doc.businessId);
  let av; try { av = await stays.availability(doc.businessId, actor, { branchId: doc.branchId, checkInDate: today, checkOutDate: T.addDays(today, 1) }); } catch (e) { return empty; }
  const types = await RoomType.find({ businessId: doc.businessId, active: true }).sort({ sortOrder: 1, baseRate: 1 });
  const left = {}; const price = {};
  for (const x of av.rooms) { const k = String(x.roomTypeId); left[k] = (left[k] || 0) + 1; if (x.quote && x.quote.total != null) price[k] = x.quote.total; }
  const rooms = [];
  for (const t of types) {
    const k = String(t._id); if (!left[k]) continue;
    const p = t.promo || {}; const live = !!(p.active && p.percentOff > 0 && (!p.validFrom || today >= p.validFrom) && (!p.validTo || today <= p.validTo));
    const base = price[k] != null ? price[k] : t.baseRate;
    rooms.push({ id: t._id, name: t.name, description: t.description, images: (t.images || []).slice(0, 5), amenities: (t.amenities || []).slice(0, 10), bedConfig: t.bedConfig, maxAdults: t.maxAdults, sizeSqm: t.sizeSqm, availableTonight: left[k],
      price: money(base), dealPrice: live ? money(Math.round(base * (1 - p.percentOff / 100))) : null, deal: live ? { title: p.title || `${p.percentOff}% off`, description: p.description, percentOff: p.percentOff, validTo: p.validTo } : null });
  }
  return { available: rooms.length > 0, currency: ctx.business.currency, rooms };
}

async function enquiry(token, { roomTypeId, name, phone, checkInDate, nights, note }) {
  const r = await require('./qr.service').resolve(token);
  const rt = await RoomType.findOne({ _id: roomTypeId, businessId: r.doc.businessId }).select('name'); if (!rt) throw ApiError.notFound('That room is not available.', 'ROOM_TYPE_NOT_FOUND');
  const text = `Room enquiry: ${rt.name}${checkInDate ? ` from ${checkInDate}` : ''}${nights ? ` for ${nights} night(s)` : ''}. ${name || ''} ${phone || ''} ${note || ''}`.trim().slice(0, 300);
  const res = await calls.raise({ ctx: r.ctx, businessId: r.doc.businessId, branchId: r.doc.branchId, kind: 'RECEPTION', table: r.kind === 'TABLE' ? r.doc : null, room: r.kind === 'ROOM' ? r.doc : null, stay: r.stay, note: text, guestName: name });
  return { sent: true, message: 'Reception has your request and will contact you shortly.', merged: res.merged };
}

module.exports = { buildReceipt, bill: billView_, payStart, payStatus, finalize, finalizeByTxn, sweep, receipt, chargeToRoom, stayView, deals, enquiry, receiptDoc };
