const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');
const { HANDLING, SCRAP_REASONS, CONTRACTOR_MODES, QUOTE_STATUSES, DELIVERY_STATUSES, PROOF_TYPES } = require('../constants/hardware');

const idParam = z.object({ id: objectId });
const productIdParam = z.object({ productId: objectId });
const money = z.coerce.number().min(0).transform(toCents);
const qty = z.coerce.number().positive().max(1000000);
const page = { page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() };

const settingsBody = z.object({ quoteValidityDays: z.coerce.number().int().min(1).max(365).optional(), reserveOnApproval: z.boolean().optional(), reservationDays: z.coerce.number().int().min(1).max(180).optional(), lowMarginPercent: z.coerce.number().min(0).max(100).optional() });
const profileBody = z.object({
  manufacturer: z.string().trim().max(80).optional(), specification: z.string().trim().max(300).optional(), technicalNotes: z.string().trim().max(1000).optional(), supplierCode: z.string().trim().max(60).optional(),
  dimensions: z.object({ length: z.coerce.number().min(0).optional(), width: z.coerce.number().min(0).optional(), height: z.coerce.number().min(0).optional() }).optional(),
  weightKg: z.coerce.number().min(0).optional(), measurable: z.boolean().optional(), divisible: z.boolean().optional(), handling: z.array(z.enum(HANDLING)).max(6).optional(), leadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
  compatibleIds: z.array(objectId).max(50).optional(), alternativeIds: z.array(objectId).max(50).optional(),
  breaks: z.array(z.object({ minQty: qty, unitPrice: money })).max(10).optional(),
  locations: z.array(z.object({ branchId: objectId, locationId: objectId })).max(20).optional(),
});
const profilesQuery = z.object({ search: z.string().trim().max(60).optional(), handling: z.enum(HANDLING).optional(), ...page });
const altQuery = z.object({ branchId: objectId.optional() });
const quoteLine = z.object({ productId: objectId, variantId: objectId.optional(), unitId: objectId.optional(), quantity: qty });
const priceQuoteBody = z.object({ customerId: objectId.optional(), items: z.array(quoteLine).min(1).max(100) });

const contractorBody = z.object({ customerId: objectId, productId: objectId.optional(), categoryId: objectId.optional(), mode: z.enum(CONTRACTOR_MODES), value: z.coerce.number().min(0), minQty: z.coerce.number().min(0).optional(), validFrom: z.coerce.date().optional(), validTo: z.coerce.date().optional(), active: z.boolean().optional(), notes: z.string().trim().max(200).optional() })
  .transform((b) => (b.mode === 'FIXED' ? { ...b, value: toCents(b.value) } : b)).refine((b) => b.productId || b.categoryId, { message: 'Choose a product or a category' }).refine((b) => b.mode !== 'PERCENT_OFF' || b.value <= 100, { message: 'Percent cannot be over 100' });
const contractorUpdate = z.object({ mode: z.enum(CONTRACTOR_MODES).optional(), value: z.coerce.number().min(0).optional(), minQty: z.coerce.number().min(0).optional(), validFrom: z.coerce.date().optional(), validTo: z.coerce.date().optional(), active: z.boolean().optional(), notes: z.string().trim().max(200).optional() })
  .transform((b) => (b.mode === 'FIXED' && b.value !== undefined ? { ...b, value: toCents(b.value) } : b));
const contractorQuery = z.object({ customerId: objectId.optional(), productId: objectId.optional() });

const locationBody = z.object({ branchId: objectId, warehouseId: objectId.optional(), code: z.string().trim().min(1).max(30), rack: z.string().trim().max(20).optional(), shelf: z.string().trim().max(20).optional(), bin: z.string().trim().max(20).optional(), description: z.string().trim().max(120).optional(), active: z.boolean().optional() });
const locationQuery = z.object({ branchId: objectId.optional() });
const pickBody = z.object({ branchId: objectId, items: z.array(z.object({ productId: objectId, variantId: objectId.optional(), quantity: qty, unitName: z.string().max(30).optional() })).min(1).max(200) });
const writeOffBody = z.object({ branchId: objectId, productId: objectId, variantId: objectId.optional(), quantity: qty, reason: z.enum(SCRAP_REASONS), note: z.string().trim().max(200).optional() });

const projectBody = z.object({ customerId: objectId, name: z.string().trim().min(2).max(120), code: z.string().trim().max(30).optional(), siteAddress: z.string().trim().max(250).optional(), poNumber: z.string().trim().max(60).optional(), status: z.enum(['ACTIVE', 'CLOSED']).optional(), notes: z.string().trim().max(300).optional() });
const projectUpdate = projectBody.partial();
const projectQuery = z.object({ customerId: objectId.optional(), status: z.enum(['ACTIVE', 'CLOSED']).optional() });

const qLine = z.object({ productId: objectId, variantId: objectId.optional(), unitId: objectId.optional(), quantity: qty, unitPrice: money.optional(), discount: money.optional() });
const quoteBody = z.object({ branchId: objectId, customerId: objectId, projectId: objectId.optional(), customerPO: z.string().trim().max(60).optional(), reference: z.string().trim().max(80).optional(), validUntil: z.coerce.date().optional(), items: z.array(qLine).min(1).max(200), deliveryCharge: money.optional(), deliveryAddress: z.string().trim().max(250).optional(), notes: z.string().trim().max(500).optional(), terms: z.string().trim().max(500).optional(), reserve: z.boolean().optional() });
const quoteUpdate = quoteBody.omit({ branchId: true, customerId: true }).partial().extend({ projectId: objectId.nullable().optional() });
const quotesQuery = z.object({ status: z.enum(QUOTE_STATUSES).optional(), customerId: objectId.optional(), projectId: objectId.optional(), branchId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), search: z.string().trim().max(60).optional(), ...page });
const approveBody = z.object({ allowBackorder: z.boolean().optional() });
const reasonBody = z.object({ reason: z.string().trim().min(3).max(200) });
const extendBody = z.object({ days: z.coerce.number().int().min(1).max(365) });
const payment = z.object({ method: z.enum(['CASH', 'MPESA', 'MOBILE_MONEY', 'CARD', 'BANK', 'OTHER']), amount: money, reference: z.string().trim().optional(), provider: z.string().trim().max(40).optional(), amountTendered: money.optional() });
const convertBody = z.object({ branchId: objectId, lines: z.array(z.object({ lineId: objectId, quantity: qty })).max(200).optional(), payments: z.array(payment).default([]), dueDate: z.coerce.date().optional(), reprice: z.boolean().optional(), notes: z.string().trim().max(200).optional() });
const backorderQuery = z.object({ branchId: objectId.optional() });

const deliveryBody = z.object({ branchId: objectId, saleId: objectId.optional(), quotationId: objectId.optional(), customerId: objectId.optional(), contactName: z.string().trim().max(80).optional(), contactPhone: z.string().trim().max(30).optional(), address: z.string().trim().max(250).optional(), scheduledFor: z.coerce.date(), window: z.string().trim().max(40).optional(), vehicle: z.string().trim().max(30).optional(), driverId: objectId.optional(), items: z.array(z.object({ productId: objectId, variantId: objectId.optional(), name: z.string().trim().max(120), unitName: z.string().trim().max(30).optional(), quantity: qty })).max(200).optional(), charge: money.optional(), cost: money.optional(), notes: z.string().trim().max(300).optional() });
const deliveryUpdate = z.object({ address: z.string().trim().max(250).optional(), scheduledFor: z.coerce.date().optional(), window: z.string().trim().max(40).optional(), vehicle: z.string().trim().max(30).optional(), driverId: objectId.optional(), contactName: z.string().trim().max(80).optional(), contactPhone: z.string().trim().max(30).optional(), charge: money.optional(), cost: money.optional(), notes: z.string().trim().max(300).optional() });
const statusBody = z.object({ status: z.enum(DELIVERY_STATUSES), note: z.string().trim().max(200).optional(), failedReason: z.string().trim().max(200).optional() });
const deliverBody = z.object({ type: z.enum(PROOF_TYPES), receivedBy: z.string().trim().max(80).optional(), otp: z.string().trim().regex(/^\d{6}$/, 'Code is 6 digits').optional(), signatureUrl: z.string().url().optional(), photoUrl: z.string().url().optional(), delivered: z.preprocess((v) => (typeof v === 'string' ? JSON.parse(v) : v), z.array(z.object({ index: z.coerce.number().int().min(0), quantity: z.coerce.number().min(0) })).optional()) });
const deliveriesQuery = z.object({ status: z.enum(DELIVERY_STATUSES).optional(), driverId: objectId.optional(), customerId: objectId.optional(), branchId: objectId.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), ...page });

const range = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional() });
const salesQuery = range.extend({ by: z.enum(['product', 'unit', 'category']).optional() });
const slowQuery = z.object({ days: z.coerce.number().int().min(7).max(730).optional(), branchId: objectId.optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() });
const branchOnly = z.object({ branchId: objectId.optional() });

// ---- extensions (transport, templates, deposits)
const { JOB_KINDS, TRACKING_METHODS, BARCODE_RULES, PRODUCT_LIFECYCLE } = require('../constants/hardware');
const pricingCtx = z.object({ distanceKm: z.coerce.number().min(0).max(5000).optional(), trips: z.coerce.number().int().min(1).max(50).optional(), weightKg: z.coerce.number().min(0).max(1e6).optional(), volumeM3: z.coerce.number().min(0).max(1e5).optional(), zone: z.string().trim().toLowerCase().max(60).optional(), vehicleType: z.string().optional(), loaders: z.coerce.number().int().min(0).max(50).optional(), loading: z.boolean().optional(), offloading: z.boolean().optional(), waitingHours: z.coerce.number().min(0).max(240).optional(), extraStops: z.coerce.number().int().min(0).max(50).optional(), orderValue: money.optional(), absorb: z.boolean().optional() });
const pricingReq = z.object({ ctx: pricingCtx.default({}), rateIds: z.array(objectId).max(5).optional(), negotiatedTotal: money.optional() });
const jobExtras = { kind: z.enum(JOB_KINDS).optional(), collectionPoint: z.string().trim().max(250).optional(), zone: z.string().trim().toLowerCase().max(60).optional(), distanceKm: z.coerce.number().min(0).max(5000).optional(), loadWeightKg: z.coerce.number().min(0).optional(), loadVolumeM3: z.coerce.number().min(0).optional(), loadNote: z.string().trim().max(200).optional(), loaders: z.array(z.object({ name: z.string().trim().min(1).max(60), userId: objectId.optional() })).max(20).optional(), subcontractor: z.object({ name: z.string().trim().max(80), phone: z.string().trim().max(30).optional(), plate: z.string().trim().max(20).optional() }).optional() };
const deliveryBodyX = deliveryBody.extend({ ...jobExtras, pricing: pricingReq.optional() });
const deliveryUpdateX = deliveryUpdate.extend(jobExtras);
const profileBodyX = profileBody.extend({ templateId: objectId.optional(), attributes: z.array(z.object({ key: z.string().trim().toLowerCase().max(30), value: z.union([z.string().max(100), z.number(), z.boolean()]) })).max(40).optional(), trackingMethod: z.enum(TRACKING_METHODS).optional(), barcodeRule: z.enum(BARCODE_RULES).optional(), altBarcodes: z.array(z.string().trim().min(3).max(60)).max(10).optional(), lifecycle: z.enum(PRODUCT_LIFECYCLE).optional(), minSellingPrice: money.optional(), minStock: z.coerce.number().min(0).optional(), maxStock: z.coerce.number().min(0).optional(), preferredSupplierId: objectId.optional(), bundle: z.array(z.object({ productId: objectId, quantity: qty })).max(50).optional() });
const settingsBodyX = settingsBody.extend({ freeDeliveryAbove: money.optional(), absorbDelivery: z.boolean().optional(), requireProofOnDelivery: z.boolean().optional() });
const convertBodyX = convertBody.extend({ deposits: z.array(z.object({ depositId: objectId, amount: money.refine((n) => n > 0, 'Amount must be more than 0') })).max(10).optional() });
module.exports = { idParam, productIdParam, settingsBody: settingsBodyX, profileBody: profileBodyX, profilesQuery, altQuery, priceQuoteBody, contractorBody, contractorUpdate, contractorQuery, locationBody, locationQuery, pickBody, writeOffBody, projectBody, projectUpdate, projectQuery, quoteBody, quoteUpdate, quotesQuery, approveBody, reasonBody, extendBody, convertBody: convertBodyX, backorderQuery, deliveryBody: deliveryBodyX, deliveryUpdate: deliveryUpdateX, pricingReq, pricingCtx, statusBody, deliverBody, deliveriesQuery, range, salesQuery, slowQuery, limitQuery, branchOnly };
