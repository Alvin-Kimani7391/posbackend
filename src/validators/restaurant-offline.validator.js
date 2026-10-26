const { z } = require('zod');
const { objectId } = require('./common');
const R = require('../constants/restaurant');
const { UNIT_NAMES } = require('../utils/restaurantUnits');

// MONEY IN THIS FILE IS ALWAYS INTEGER CENTS (suffix "Cents"): the device never sends floats.
const str = (n = 200) => z.string().trim().max(n);
const cents = z.number().int().min(0).max(100000000000);
const posCents = z.number().int().min(1).max(100000000000);
const id80 = z.string().trim().min(8).max(80);
const loc = z.enum(R.INGREDIENT_LOCATIONS);

/** A server id, or the clientOpId / clientRef of the operation that created the thing on this device. */
const orderRef = z.object({ orderId: objectId.optional(), opId: id80.optional(), clientRef: str(80).optional() }).refine((r) => r.orderId || r.opId || r.clientRef, 'orderRef needs orderId, opId or clientRef');
const billRef = z.object({ billId: objectId.optional(), opId: id80.optional(), orderRef: orderRef.optional() }).refine((r) => r.billId || r.opId || r.orderRef, 'billRef needs billId, opId or orderRef');
const itemRef = z.object({ itemId: objectId.optional(), clientItemId: str(80).optional() }).refine((r) => r.itemId || r.clientItemId, 'itemRef needs itemId or clientItemId');

const modSel = z.object({ groupId: objectId.optional(), optionId: objectId.optional(), name: str(120).optional(), quantity: z.coerce.number().int().min(1).optional() }).passthrough();
const itemInput = z.object({
  menuItemId: objectId, quantity: z.coerce.number().positive().max(999), variantId: objectId.optional(), modifiers: z.array(modSel).max(40).optional(),
  comboPicks: z.array(z.object({ groupId: objectId, menuItemId: objectId, quantity: z.coerce.number().int().min(1).optional(), variantId: objectId.optional() })).optional(),
  notes: str(300).optional(), allergyNotes: str(300).optional(), course: z.coerce.number().int().min(1).max(9).optional(), seatNumber: z.coerce.number().int().min(1).max(100).optional(),
  clientItemId: str(80).min(4),
});
const delivery = z.object({ phone: str(20).optional(), address: str(300).optional(), fee: z.number().int().min(0).optional(), notes: str(300).optional() }).passthrough();

const payment = z.object({
  method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'CREDIT', 'DEPOSIT', 'ROOM', 'OTHER']),
  amountCents: posCents, tenderedCents: cents.optional(), reference: str(100).optional(), network: str(40).optional(), payerPhone: str(20).optional(),
  reservationId: objectId.optional(), stayId: objectId.optional(),
});

const base = { clientOpId: id80, occurredAt: z.coerce.date(), seq: z.number().int().min(0).optional() };
const op = (type, shape) => z.object({ ...base, type: z.literal(type), ...shape });

const opSchema = z.discriminatedUnion('type', [
  op('openShift', { payload: z.object({ branchId: objectId, registerId: objectId.optional(), openingCashCents: cents }) }),
  op('createOrder', { payload: z.object({ branchId: objectId, orderType: z.enum(R.ORDER_TYPES).optional(), source: z.enum(R.ORDER_SOURCES).optional(), tableId: objectId.optional(), guestCount: z.coerce.number().int().min(0).max(500).optional(), customerId: objectId.optional(), customerName: str(120).optional(), customerPhone: str(20).optional(), waiterId: objectId.optional(), reservationId: objectId.optional(), roomId: objectId.optional(), stayId: objectId.optional(), notes: str(500).optional(), priority: z.enum(R.TICKET_PRIORITY).optional(), delivery: delivery.optional(), clientRef: str(80).optional() }) }),
  op('addItems', { orderRef, payload: z.object({ items: z.array(itemInput).min(1).max(60), sendNow: z.boolean().optional() }) }),
  op('sendOrder', { orderRef }),
  op('itemStatus', { orderRef, itemRefs: z.array(itemRef).min(1).max(100), payload: z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'SERVED']) }) }),
  op('serve', { orderRef, payload: z.object({ itemRefs: z.array(itemRef).max(100).optional(), allReady: z.boolean().optional() }).refine((b) => b.allReady || b.itemRefs?.length, 'Choose items or allReady') }),
  op('cancelItem', { orderRef, itemRef, payload: z.object({ reason: str(300).optional(), quantity: z.coerce.number().positive().optional() }).optional() }),
  op('cancelOrder', { orderRef, payload: z.object({ reason: z.string().trim().min(3).max(300) }) }),
  op('handoff', { orderRef, itemRefs: z.array(itemRef).min(1).max(100) }),            // kitchen: "Handed to waiter"
  op('generateBill', { orderRef, payload: z.object({ label: str(60).optional(), customerId: objectId.optional() }).optional() }),
  op('pay', { billRef, payload: z.object({ customerId: objectId.optional(), payments: z.array(payment).min(1).max(10) }) }),
  op('addTip', { billRef, payload: z.object({ amountCents: posCents, method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']), reference: str(100).optional(), waiterId: objectId.optional() }) }),
  op('receiveStock', { payload: z.object({ branchId: objectId, supplierId: objectId.optional(), invoiceNumber: str(60).optional(), amountPaidCents: cents.optional(), notes: str(300).optional(), lines: z.array(z.object({ ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), unitCostCents: cents, batchNumber: str(60).optional(), expiryDate: z.coerce.date().optional(), location: loc.optional() })).min(1).max(100) }) }),
  op('waste', { payload: z.object({ branchId: objectId, ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), kind: z.enum(['WASTE', 'SPOILAGE', 'EXPIRED', 'STAFF_MEAL', 'COMPLIMENTARY', 'REMAKE']), reason: str(300).optional(), location: loc.optional() }) }),
  op('adjustStock', { payload: z.object({ branchId: objectId, ingredientId: objectId, quantity: z.coerce.number().positive(), unit: z.enum(UNIT_NAMES).optional(), direction: z.enum(['IN', 'OUT']), reason: z.string().trim().min(3).max(300), location: loc.optional() }) }),
]);

const replayBody = z.object({
  deviceId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Invalid device id'),
  deviceTime: z.coerce.date().optional(),
  appVersion: str(40).optional(),
  ops: z.array(z.unknown()).min(1).max(200),       // each op is validated one by one so a single bad op never rejects the whole batch
});
const snapshotQuery = z.object({ branchId: objectId, since: z.coerce.date().optional() });
const opsQuery = z.object({ branchId: objectId.optional(), status: z.enum(['PENDING', 'APPLIED', 'CONFLICT']).optional(), reviewed: z.enum(['true', 'false']).transform((x) => x === 'true').optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30) });
const idParam = z.object({ id: objectId });

module.exports = { opSchema, replayBody, snapshotQuery, opsQuery, idParam };
