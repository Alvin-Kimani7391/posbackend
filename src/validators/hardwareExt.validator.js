const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');
const H = require('../constants/hardware');
const money = z.coerce.number().min(0).transform(toCents);
const pos = z.coerce.number().positive().transform(toCents);
const qty = z.coerce.number().positive().max(1000000);
const page = { page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() };
const methods = z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']);
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((x) => x === 'true')]);
const idParam = z.object({ id: objectId });
const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional() });

// ---- fleet + transport
const vehicleBody = z.object({ plate: z.string().trim().min(3).max(20), name: z.string().trim().max(60).optional(), type: z.enum(H.VEHICLE_TYPES).optional(), capacityKg: z.coerce.number().min(0).optional(), capacityM3: z.coerce.number().min(0).optional(), ownership: z.enum(H.OWNERSHIP).optional(), ownerName: z.string().trim().max(80).optional(), ownerPhone: z.string().trim().max(30).optional(), fuelType: z.enum(['PETROL', 'DIESEL', 'OTHER']).optional(), odometerKm: z.coerce.number().min(0).optional(), insuranceExpiry: z.coerce.date().optional(), inspectionExpiry: z.coerce.date().optional(), licenceExpiry: z.coerce.date().optional(), nextServiceKm: z.coerce.number().min(0).optional(), nextServiceDate: z.coerce.date().optional(), defaultDriverId: objectId.optional(), status: z.enum(H.VEHICLE_STATUS).optional(), branchId: objectId.optional(), notes: z.string().trim().max(300).optional() });
const vehicleUpdate = vehicleBody.partial();
const vehicleQuery = z.object({ status: z.enum(H.VEHICLE_STATUS).optional(), ownership: z.enum(H.OWNERSHIP).optional() });
const alertQuery = z.object({ days: z.coerce.number().int().min(1).max(365).optional() });
const rateBody = z.object({ name: z.string().trim().min(2).max(80), component: z.enum(H.RATE_COMPONENTS), basis: z.enum(H.RATE_BASIS), value: money, minCharge: money.optional(), zone: z.string().trim().toLowerCase().max(60).optional(), vehicleType: z.enum(H.VEHICLE_TYPES).optional(), active: z.boolean().optional(), notes: z.string().trim().max(200).optional() });
const rateUpdate = rateBody.partial();
const rateQuery = z.object({ component: z.enum(H.RATE_COMPONENTS).optional(), active: bool.optional() });
const assignBody = z.object({ fleetVehicleId: objectId.optional(), driverId: objectId.optional(), loaders: z.array(z.object({ name: z.string().trim().min(1).max(60), userId: objectId.optional() })).max(20).optional(), subcontractor: z.object({ name: z.string().trim().max(80), phone: z.string().trim().max(30).optional(), plate: z.string().trim().max(20).optional() }).optional(), allowShared: z.boolean().optional(), allowOverload: z.boolean().optional() });
const costBody = z.object({ deliveryId: objectId.optional(), fleetVehicleId: objectId.optional(), type: z.enum(H.COST_TYPES), amount: pos.optional(), date: z.coerce.date().optional(), payee: z.string().trim().max(80).optional(), payeeUserId: objectId.optional(), paid: z.boolean().optional(), paymentMethod: methods.optional(), reference: z.string().trim().max(60).optional(), litres: z.coerce.number().min(0).optional(), odometerKm: z.coerce.number().min(0).optional(), downtimeDays: z.coerce.number().min(0).max(365).optional(), expenseId: objectId.optional(), note: z.string().trim().max(200).optional() });
const costQuery = z.object({ deliveryId: objectId.optional(), fleetVehicleId: objectId.optional(), type: z.enum(H.COST_TYPES).optional(), paid: bool.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional(), ...page });
const voidBody = z.object({ reason: z.string().trim().min(3).max(200) });
const payCostBody = z.object({ paymentMethod: methods, reference: z.string().trim().max(60).optional() });
const jobPaymentBody = z.object({ kind: z.enum(['DEPOSIT', 'PAYMENT', 'REFUND']).optional(), amount: pos, method: methods, reference: z.string().trim().max(60).optional() });
const returnBody = z.object({ odometerStart: z.coerce.number().min(0).optional(), odometerEnd: z.coerce.number().min(0).optional(), returnedAt: z.coerce.date().optional(), returnTrip: z.boolean().optional() });

// ---- supplier / landed / procurement
const quoteBody = z.object({ supplierId: objectId, productId: objectId, unitName: z.string().trim().max(30).optional(), unitPrice: money, discountPercent: z.coerce.number().min(0).max(100).optional(), minQty: z.coerce.number().min(0).optional(), leadTimeDays: z.coerce.number().int().min(0).max(365).optional(), validUntil: z.coerce.date().optional(), reference: z.string().trim().max(60).optional(), notes: z.string().trim().max(200).optional() });
const quoteQuery = z.object({ productId: objectId.optional(), supplierId: objectId.optional(), status: z.enum(['OPEN', 'ACCEPTED', 'REJECTED', 'EXPIRED']).optional(), ...page });
const quoteStatusBody = z.object({ status: z.enum(['OPEN', 'ACCEPTED', 'REJECTED', 'EXPIRED']) });
const compareQuery = z.object({ productId: objectId, includeAlternatives: bool.optional(), qty: qty.optional() });
const priceChangeQuery = z.object({ days: z.coerce.number().int().min(7).max(730).optional(), thresholdPct: z.coerce.number().min(0).max(500).optional() });
const landedBody = z.object({ purchaseId: objectId, type: z.enum(H.LANDED_TYPES), amount: pos.optional(), allocateBy: z.enum(['VALUE', 'QUANTITY']).optional(), payee: z.string().trim().max(80).optional(), reference: z.string().trim().max(60).optional(), expenseId: objectId.optional(), date: z.coerce.date().optional(), note: z.string().trim().max(200).optional() });
const purchaseParam = z.object({ purchaseId: objectId });

// ---- BOQ
const boqLine = z.object({ productId: objectId.optional(), description: z.string().trim().max(160).optional(), unitName: z.string().trim().max(30).optional(), quantity: qty, estUnitCost: money.optional(), estUnitPrice: money.optional() }).refine((l) => l.productId || l.description, { message: 'Give a product or a description' });
const boqBody = z.object({ lines: z.array(boqLine).min(1).max(2000), mode: z.enum(['REPLACE', 'APPEND']).optional() });
const boqImport = z.object({ csv: z.string().min(5).max(600000), mode: z.enum(['REPLACE', 'APPEND']).optional() });
const projectParam = z.object({ projectId: objectId });

// ---- deposits
const depositBody = z.object({ branchId: objectId, customerId: objectId, projectId: objectId.optional(), quotationId: objectId.optional(), amount: pos, method: methods, reference: z.string().trim().max(60).optional(), notes: z.string().trim().max(200).optional() });
const depositQuery = z.object({ customerId: objectId.optional(), projectId: objectId.optional(), status: z.enum(['OPEN', 'USED', 'REFUNDED']).optional(), ...page });
const depositRefund = z.object({ amount: pos, reason: z.string().trim().min(3).max(200) });
const customerParam = z.object({ customerId: objectId });

// ---- templates, barcode, repack
const attr = z.object({ key: z.string().trim().toLowerCase().min(1).max(30), label: z.string().trim().min(1).max(40), type: z.enum(H.ATTR_TYPES).optional(), options: z.array(z.string().trim().max(40)).max(50).optional(), unit: z.string().trim().max(12).optional(), required: z.boolean().optional(), variantAxis: z.boolean().optional() });
const templateBody = z.object({ name: z.string().trim().min(2).max(60), categoryId: objectId.optional(), trackingMethod: z.enum(H.TRACKING_METHODS).optional(), measurable: z.boolean().optional(), divisible: z.boolean().optional(), suggestedBaseUnit: z.string().trim().max(20).optional(), suggestedUnits: z.array(z.object({ name: z.string().trim().max(30), factor: z.coerce.number().positive() })).max(10).optional(), attributes: z.array(attr).max(40).optional(), active: z.boolean().optional() });
const templateUpdate = templateBody.partial();
const barcodeParam = z.object({ code: z.string().trim().min(3).max(60) });
const repackBody = z.object({ branchId: objectId, sourceProductId: objectId, sourceQty: qty, targetProductId: objectId, targetQty: qty, wastageQty: z.coerce.number().min(0).optional(), note: z.string().trim().max(200).optional() });
const repackQuery = z.object({ branchId: objectId.optional(), ...page });

// ---- finance
const classifyBody = z.object({ kind: z.enum(H.EXPENSE_KINDS).optional(), payee: z.string().trim().max(80).optional(), dueDate: z.coerce.date().optional(), paid: z.boolean().optional() });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const budgetBody = z.object({ branchId: objectId.optional(), month, items: z.array(z.object({ category: z.string().trim().min(2).max(40), amount: money })).min(1).max(40) });
const budgetQuery = z.object({ branchId: objectId.optional(), month });
const recurringBody = z.object({ branchId: objectId, category: z.string().trim().min(2).max(40), kind: z.enum(H.EXPENSE_KINDS).optional(), amount: pos, description: z.string().trim().max(120).optional(), payee: z.string().trim().max(80).optional(), frequency: z.enum(['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY']), nextDue: z.coerce.date(), endsOn: z.coerce.date().optional() });
const branchOnly = z.object({ branchId: objectId.optional() });
module.exports = { idParam, range, vehicleBody, vehicleUpdate, vehicleQuery, alertQuery, rateBody, rateUpdate, rateQuery, assignBody, costBody, costQuery, voidBody, payCostBody, jobPaymentBody, returnBody, quoteBody, quoteQuery, quoteStatusBody, compareQuery, priceChangeQuery, landedBody, purchaseParam, boqBody, boqImport, projectParam, depositBody, depositQuery, depositRefund, customerParam, templateBody, templateUpdate, barcodeParam, repackBody, repackQuery, classifyBody, budgetBody, budgetQuery, recurringBody, branchOnly };
