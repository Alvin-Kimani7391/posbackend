const { z } = require('zod');
const { objectId, paginationQuery, anyPhone } = require('./common');
const { toCents } = require('../utils/money');
const H = require('../constants/hospitality');

const money = z.coerce.number().positive().transform(toCents);
const money0 = z.coerce.number().min(0).transform(toCents);
const moneyAny = z.coerce.number().transform(toCents);
const str = (n = 200) => z.string().trim().max(n);
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, 'Use HH:MM');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const idParam = z.object({ id: objectId });
const lineParam = z.object({ id: objectId, lineId: objectId });
const branchQ = z.object({ branchId: objectId.optional() });
const reason = z.string().trim().min(3, 'Give a reason').max(300);

// ---- settings
const feeType = z.enum(['NONE', 'FLAT', 'PERCENT', 'HOURLY', 'FULL_NIGHT']);
const feeValue = (t) => (t.feeType === 'FLAT' || t.feeType === 'HOURLY' ? { ...t, value: toCents(t.value) } : t);
const earlyTier = z.object({ from: hhmm, feeType, value: z.coerce.number().min(0).default(0) }).transform(feeValue);
const lateTier = z.object({ until: hhmm, feeType, value: z.coerce.number().min(0).default(0) }).transform(feeValue);
const settingsSchema = z.object({
  checkIn: z.object({ time: hhmm }).partial(),
  checkOut: z.object({ time: hhmm }).partial(),
  earlyCheckIn: z.object({ allowed: z.boolean(), tiers: z.array(earlyTier).max(10), beforeFirstTier: z.enum(['FULL_NIGHT', 'DENY']), requiresRoomReady: z.boolean() }).partial(),
  lateCheckOut: z.object({ allowed: z.boolean(), graceMinutes: z.coerce.number().int().min(0).max(240), tiers: z.array(lateTier).max(10), afterLastTier: z.enum(['FULL_NIGHT', 'DENY']) }).partial(),
  stay: z.object({
    minNights: z.coerce.number().int().min(1), maxNights: z.coerce.number().int().min(1), maxAdvanceDays: z.coerce.number().int().min(1), allowDayUse: z.boolean(),
    dayUse: z.object({ hours: z.coerce.number().int().min(1).max(12), percentOfNightly: z.coerce.number().min(0).max(100) }).partial(), earlyDeparture: z.enum(['CHARGE_BOOKED', 'CHARGE_USED']),
    requireIdAtCheckIn: z.boolean(), requirePhone: z.boolean(), allowOverrideRate: z.boolean(),
  }).partial(),
  deposit: z.object({ required: z.boolean(), type: z.enum(['FLAT', 'PERCENT', 'FIRST_NIGHT']), value: z.coerce.number().min(0), requiredBeforeCheckIn: z.boolean() }).partial()
    .transform((d) => (d.type === 'FLAT' && d.value !== undefined ? { ...d, value: toCents(d.value) } : d)),
  cancellation: z.object({ freeUntilHours: z.coerce.number().min(0), penaltyType: z.enum(['NONE', 'FIRST_NIGHT', 'PERCENT', 'FLAT']), value: z.coerce.number().min(0) }).partial()
    .transform((d) => (d.penaltyType === 'FLAT' && d.value !== undefined ? { ...d, value: toCents(d.value) } : d)),
  noShow: z.object({ afterHours: z.coerce.number().int().min(1).max(72), chargePenalty: z.boolean(), autoRelease: z.boolean() }).partial(),
  tax: z.object({ roomTaxRate: z.coerce.number().min(0).max(100).nullable(), levies: z.array(z.object({ name: str(60).min(1), percent: z.coerce.number().min(0).max(100), taxRate: z.coerce.number().min(0).max(100).optional() })).max(10) }).partial(),
  selfService: z.object({ selfCheckIn: z.boolean(), selfCheckInOpensHoursBefore: z.coerce.number().int().min(0).max(24), requireDepositPaidForSelfCheckIn: z.boolean(), selfCheckOut: z.boolean(), guestPinRequired: z.boolean(), guestPinLength: z.coerce.number().int().min(4).max(8) }).partial(),
  housekeeping: z.object({ autoCreateTasks: z.boolean(), requireInspection: z.boolean(), stayoverCleaning: z.boolean() }).partial(),
  roomService: z.object({ enabled: z.boolean(), autoPostToFolio: z.boolean(), hoursStart: hhmm.or(z.literal('')), hoursEnd: hhmm.or(z.literal('')), minOrderCents: money0, deliveryFeeCents: money0 }).partial(),
}).partial().strict();

// ---- room types and rooms
const seasonal = z.object({ name: str(60).optional(), startDate: ymd, endDate: ymd, rate: money0, days: z.array(z.number().int().min(0).max(6)).optional() });
const roomTypeBody = z.object({
  promo: z.object({ active: z.boolean().optional(), title: str(80).optional(), description: str(300).optional(), percentOff: z.coerce.number().min(0).max(90).optional(), validFrom: ymd.or(z.literal('')).optional(), validTo: ymd.or(z.literal('')).optional() }).optional(),
  name: str(80).min(1), code: str(12).optional(), description: str(1000).optional(), images: z.array(str(500)).max(12).optional(),
  baseRate: money0, weekendRate: money0.optional(), weekendDays: z.array(z.number().int().min(0).max(6)).optional(), seasonalRates: z.array(seasonal).max(40).optional(),
  baseOccupancy: z.coerce.number().int().min(1).optional(), maxAdults: z.coerce.number().int().min(1).optional(), maxChildren: z.coerce.number().int().min(0).optional(),
  extraAdultRate: money0.optional(), childRate: money0.optional(), freeChildAge: z.coerce.number().int().min(0).optional(),
  mealPlanPrices: z.record(z.enum(['BED_BREAKFAST', 'HALF_BOARD', 'FULL_BOARD']), money0).optional(),
  amenities: z.array(str(60)).max(40).optional(), bedConfig: str(80).optional(), sizeSqm: z.coerce.number().positive().optional(), taxRate: z.coerce.number().min(0).max(100).optional(), sortOrder: z.coerce.number().int().optional(),
});
const roomTypeUpdate = roomTypeBody.partial().extend({ active: z.boolean().optional() });
const roomBody = z.object({ branchId: objectId, roomTypeId: objectId, number: str(20).min(1), name: str(60).optional(), floor: str(20).optional(), notes: str(500).optional() });
const roomUpdate = roomBody.omit({ branchId: true }).partial().extend({ active: z.boolean().optional(), qrEnabled: z.boolean().optional() });
const roomBulk = z.object({ branchId: objectId, roomTypeId: objectId, numbers: z.array(str(20).min(1)).min(1).max(200), floor: str(20).optional() });
const roomStatus = z.object({ status: z.enum(['AVAILABLE', 'OUT_OF_ORDER']), reason: str(300).optional(), until: z.coerce.date().optional() });
const housekeepingBody = z.object({ housekeeping: z.enum(H.HOUSEKEEPING_STATUS) });

// ---- stays
const guest = z.object({
  name: str(120).min(2), phone: anyPhone.optional(), email: z.string().trim().email().max(120).optional(), idType: z.enum(H.ID_TYPES).optional(), idNumber: str(40).optional(),
  nationality: str(60).optional(), address: str(200).optional(), company: str(120).optional(), vehiclePlate: str(20).optional(),
});
const guestPatch = guest.partial();
const payment = z.object({ method: z.enum(H.STAY_PAY_METHODS), amount: money, tendered: money.optional(), reference: str(100).optional(), network: str(40).optional(), payerPhone: str(20).optional(), customerId: objectId.optional() });
const availabilityQuery = z.object({ branchId: objectId, checkInDate: ymd, checkOutDate: ymd, roomTypeId: objectId.optional(), checkInTime: hhmm.optional(), checkOutTime: hhmm.optional(), adults: z.coerce.number().int().min(1).optional(), children: z.coerce.number().int().min(0).optional(), mealPlan: z.enum(H.MEAL_PLANS).optional() });
const reserveBody = z.object({
  branchId: objectId, roomId: objectId.optional(), roomTypeId: objectId.optional(), checkInDate: ymd, checkOutDate: ymd.optional(), checkInTime: hhmm.optional(), checkOutTime: hhmm.optional(), dayUse: z.boolean().optional(),
  guest, customerId: objectId.optional(), adults: z.coerce.number().int().min(1).max(20).optional(), children: z.coerce.number().int().min(0).max(20).optional(), otherGuests: z.array(z.object({ name: str(120), idType: z.enum(H.ID_TYPES).optional(), idNumber: str(40).optional() })).max(20).optional(),
  mealPlan: z.enum(H.MEAL_PLANS).optional(), source: z.enum(H.BOOKING_SOURCES).optional(), specialRequests: str(500).optional(), notes: str(500).optional(), groupId: str(40).optional(),
  rateOverride: money0.optional(), rateOverrideReason: str(200).optional(), deposit: payment.optional(), clientRef: str(80).optional(), checkInNow: z.boolean().optional(),
}).refine((b) => b.roomId || b.roomTypeId, { message: 'Choose a room or a room type', path: ['roomId'] }).refine((b) => b.dayUse || b.checkOutDate, { message: 'Choose the check-out date', path: ['checkOutDate'] });
const checkInBody = z.object({ guest: guestPatch.optional(), adults: z.coerce.number().int().min(1).optional(), children: z.coerce.number().int().min(0).optional(), otherGuests: z.array(z.object({ name: str(120), idType: z.enum(H.ID_TYPES).optional(), idNumber: str(40).optional() })).max(20).optional(), roomId: objectId.optional(), waiveEarlyFee: z.boolean().optional(), force: z.boolean().optional() });
const checkOutBody = z.object({ payments: z.array(payment).max(6).optional(), customerId: objectId.optional(), waiveLateFee: z.boolean().optional(), closeUnpaidReason: str(300).optional() });
const quoteQuery = z.object({ at: z.coerce.date().optional() });
const moveBody = z.object({ roomId: objectId, reason: str(300).optional() });
const datesBody = z.object({ checkInDate: ymd.optional(), checkOutDate: ymd.optional(), reason: str(300).optional() }).refine((b) => b.checkInDate || b.checkOutDate, { message: 'Give a new date' });
const stayUpdate = z.object({ guest: guestPatch.optional(), notes: str(500).optional(), specialRequests: str(500).optional(), adults: z.coerce.number().int().min(1).optional(), children: z.coerce.number().int().min(0).optional(), qrOrdersEnabled: z.boolean().optional(), customerId: objectId.optional(), otherGuests: z.array(z.object({ name: str(120), idType: z.enum(H.ID_TYPES).optional(), idNumber: str(40).optional() })).max(20).optional() });
const cancelBody = z.object({ reason, waiveFee: z.boolean().optional() });
const noShowBody = z.object({ reason: str(300).optional(), waiveFee: z.boolean().optional() });
const stayListQuery = paginationQuery.extend({ branchId: objectId.optional(), status: str(80).optional(), roomId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), arriving: z.coerce.boolean().optional(), departing: z.coerce.boolean().optional() });
const chargeBody = z.object({ type: z.enum(H.FOLIO_TYPES.filter((t) => !['ROOM', 'LEVY', 'EARLY_CHECKIN', 'LATE_CHECKOUT', 'CANCELLATION', 'NO_SHOW'].includes(t))), description: str(160).min(2), quantity: z.coerce.number().positive().max(1000).default(1), unitPrice: moneyAny, taxRate: z.coerce.number().min(0).max(100).optional() });
const folioPayBody = z.object({ kind: z.enum(['DEPOSIT', 'PAYMENT']).optional(), method: z.enum(H.STAY_PAY_METHODS), amount: money, tendered: money.optional(), reference: str(100).optional(), network: str(40).optional(), payerPhone: str(20).optional(), customerId: objectId.optional() });
const stkBody = z.object({ phone: z.string().trim().min(9), amountCents: money.optional(), customerName: str(120).optional() });
const manualBody = z.object({ amountCents: money.optional() });
const claimBody = z.object({ receiptCode: z.string().trim().refine((v) => /^[A-Za-z][A-Za-z0-9]{9}$/.test(v), 'Enter the 10-character M-PESA code') });
const refParam = z.object({ reference: z.string().trim().min(3) });
const verifyBody = z.object({ approve: z.boolean(), note: str(300).optional() });
const entryParam = z.object({ id: objectId, entryId: objectId });
const unverifiedQuery = z.object({ branchId: objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const contextQuery = z.object({ branchId: objectId });
const openShiftBody = z.object({ branchId: objectId, registerId: objectId, openingCash: money0 });
const folioRefundBody = z.object({ amount: money, method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']), reason });
const voidLineBody = z.object({ reason });

// ---- housekeeping tasks
const taskQuery = z.object({ branchId: objectId.optional(), status: str(60).optional(), assignedTo: objectId.optional(), mine: z.coerce.boolean().optional() });
const taskCreate = z.object({ roomId: objectId, type: z.enum(H.HK_TASK_TYPES), priority: z.enum(['NORMAL', 'URGENT']).optional(), note: str(500).optional(), assignedTo: z.preprocess((v) => (v === '' || v === null ? undefined : v), objectId.optional()), dueAt: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.coerce.date().optional()) });
const taskUpdate = z.object({ action: z.enum(['assign', 'start', 'complete', 'cancel']), assignedTo: objectId.optional(), note: str(500).optional() }).refine((b) => b.action !== 'assign' || b.assignedTo, { message: 'Choose who', path: ['assignedTo'] });

// ---- reports
const rangeQuery = z.object({ branchId: objectId.optional(), from: ymd.optional(), to: ymd.optional() });
const boardQuery = z.object({ branchId: objectId, date: ymd.optional() });

// ---- staff side of guest ordering
const requestQuery = z.object({ branchId: objectId.optional(), status: str(80).optional() });
const acceptBody = z.object({ dropIndexes: z.array(z.number().int().min(0)).max(100).optional(), sendNow: z.boolean().optional() });
const rejectBody = z.object({ reason: str(200).optional() });
const callQuery = z.object({ branchId: objectId.optional(), status: str(80).optional(), kind: z.enum(H.CALL_KINDS).optional() });
const callCreate = z.object({ tableId: objectId.optional(), roomId: objectId.optional(), kind: z.enum(H.CALL_KINDS), note: str(300).optional() });
const qrQuery = z.object({ kind: z.enum(H.QR_KINDS), branchId: objectId.optional() });
const qrParam = z.object({ kind: z.enum(H.QR_KINDS), id: objectId });
const qrEnable = z.object({ enabled: z.boolean() });

// ---- public (guest) side: no login. Strict shapes, small limits.
const pin = z.string().trim().regex(/^\d{4,8}$/).optional();
const modSel = z.object({ groupId: objectId, optionId: objectId, quantity: z.coerce.number().int().min(1).max(20).optional() });
const guestItem = z.object({
  menuItemId: objectId, quantity: z.coerce.number().positive().max(200), variantId: objectId.optional(), modifiers: z.array(modSel).max(30).optional(),
  comboPicks: z.array(z.object({ groupId: objectId, menuItemId: objectId, quantity: z.coerce.number().int().min(1).optional(), variantId: objectId.optional() })).max(20).optional(),
  notes: str(200).optional(), allergyNotes: str(200).optional(),
});
const guestOrder = z.object({ items: z.array(guestItem).min(1).max(100), guest: z.object({ name: str(80).optional(), phone: str(25).optional() }).optional(), notes: str(300).optional(), clientRef: str(80).optional(), pin }).strict();
const guestCall = z.object({ kind: z.enum(H.CALL_KINDS), note: str(300).optional(), guestName: str(80).optional(), pin }).strict();
const guestPinOnly = z.object({ pin, note: str(300).optional() }).strict();
const guestSelfCheckIn = z.object({ bookingCode: str(12).min(4), phoneLast4: z.string().regex(/^\d{4}$/) }).strict();
const tokenParam = z.object({ token: z.string().min(30).max(80) });
const payRefParam = z.object({ token: z.string().min(30).max(80), reference: z.string().regex(/^MPX-[A-F0-9]{12}$/) });
const acctReg = z.object({ name: str(80).min(2), email: z.string().trim().toLowerCase().email().max(120).optional().or(z.literal('').transform(() => undefined)), phone: str(20).optional().or(z.literal('').transform(() => undefined)), password: z.string().min(6).max(100) }).strict();
const acctLogin = z.object({ identifier: str(120).min(3), password: z.string().min(1).max(100) }).strict();
const acctGoogle = z.object({ credential: z.string().min(20).max(4000) }).strict();
const acctClaim = z.object({ references: z.array(z.string().regex(/^MPX-[A-F0-9]{12}$/)).max(50) }).strict();
const acctRef = z.object({ token: z.string().min(30).max(80), reference: z.string().regex(/^MPX-[A-F0-9]{12}$/) });
const guestPay = z.object({ pin, phone: str(20).min(9), orderId: objectId.optional(), billId: objectId.optional(), kind: z.enum(['BILL', 'STAY']).optional() }).strict();
const guestCharge = z.object({ pin, orderId: objectId, billId: objectId.optional() }).strict();
const guestEnquiry = z.object({ roomTypeId: objectId, name: str(80).optional(), phone: str(25).optional(), checkInDate: ymd.optional(), nights: z.coerce.number().int().min(1).max(60).optional(), note: str(120).optional() }).strict();
const pinQuery = z.object({ pin });

module.exports = {
  idParam, lineParam, branchQ, settingsSchema, roomTypeBody, roomTypeUpdate, roomBody, roomUpdate, roomBulk, roomStatus, housekeepingBody,
  availabilityQuery, reserveBody, checkInBody, checkOutBody, quoteQuery, moveBody, datesBody, stayUpdate, cancelBody, noShowBody, stayListQuery, chargeBody, folioPayBody, folioRefundBody, voidLineBody, stkBody, manualBody, claimBody, refParam, verifyBody, entryParam, unverifiedQuery, contextQuery, openShiftBody,
  taskQuery, taskCreate, taskUpdate, rangeQuery, boardQuery, requestQuery, acceptBody, rejectBody, callQuery, callCreate, qrQuery, qrParam, qrEnable,
  guestOrder, guestCall, guestPinOnly, guestSelfCheckIn, tokenParam, pinQuery, payRefParam, acctReg, acctLogin, acctGoogle, acctClaim, acctRef, guestPay, guestCharge, guestEnquiry,
};
