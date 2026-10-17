const { z } = require('zod');
const { objectId } = require('./common');

const idParam = z.object({ id: objectId });
const productParam = z.object({ productId: objectId });
const userParam = z.object({ userId: objectId });
const page = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const optDate = z.coerce.date().optional();
const text = (max = 300) => z.string().trim().max(max);
const reason = z.object({ reason: text().min(3) });

// ---- medicines + settings
const storageSchema = z.object({ instructions: text(300).optional(), minC: z.coerce.number().optional(), maxC: z.coerce.number().optional(), coldChain: z.boolean().optional() });
const medicineSchema = z.object({
  brandName: text(120).optional(), genericName: text(160).min(2), strength: text(60).min(1), dosageForm: text(40).min(2), packSize: text(80).optional(), manufacturer: text(120).optional(),
  registrationNumber: text(80).optional(), supplierCode: text(60).optional(), classification: text(40).optional(), storage: storageSchema.optional(), unitOfSale: text(30).optional(),
  infoReference: text(300).optional(), alternatives: z.array(objectId).max(20).optional(),
});
const medicineListQuery = z.object({ ...page, q: text(80).optional(), classification: text(40).optional(), status: z.enum(['active', 'discontinued', 'recalled', 'quarantined']).optional(), dosageForm: text(40).optional() });
const medicineStatusSchema = z.object({ status: z.enum(['active', 'discontinued', 'recalled', 'quarantined']), reason: text().optional() });
const classSchema = z.object({
  code: text(40).min(2).regex(/^[A-Za-z0-9_]+$/, 'Letters, numbers and underscore only'), label: text(80).optional(), requiresPrescription: z.boolean().default(false),
  dispenserOnly: z.boolean().default(false), restricted: z.boolean().default(false), poisonsBook: z.boolean().default(false), maxQtyPerDispense: z.coerce.number().min(0).optional(),
});
const settingsSchema = z.object({
  classes: z.array(classSchema).min(1).max(20).optional(), prescriptionValidDays: z.coerce.number().int().min(1).max(730).optional(), recordRetentionYears: z.coerce.number().int().min(1).max(30).optional(),
  requireDispenserCredential: z.boolean().optional(), allowOfflineOtc: z.boolean().optional(), requireApprovedSuppliers: z.boolean().optional(), refillValidDays: z.coerce.number().int().min(1).max(730).optional(), noRefillsForRestricted: z.boolean().optional(), oneRestrictedPerPrescription: z.boolean().optional(), requireCountersign: z.boolean().optional(), expiryWarnDays: z.array(z.coerce.number().int().min(1).max(365)).min(1).max(6).optional(),
  rooms: z.array(z.object({ place: text(60).min(1), minC: z.coerce.number(), maxC: z.coerce.number() }).refine((r) => r.minC < r.maxC, { message: 'minC must be below maxC' })).max(30).optional(),
});
const credentialSchema = z.object({ role: z.enum(['PHARMACIST', 'DISPENSER', 'ASSISTANT']), registrationNumber: text(60).optional(), expiresAt: z.coerce.date().optional() });

// ---- patients
const consent = z.object({ given: z.boolean().default(true), basis: text(200).min(3) });
const patientSchema = z.object({
  name: text(120).min(2), phone: text(20).optional(), idType: z.enum(['NATIONAL_ID', 'PASSPORT', 'BIRTH_CERT', 'OTHER']).optional(), idNumber: text(40).optional(),
  dateOfBirth: z.coerce.date().optional(), sex: z.enum(['F', 'M', 'OTHER']).optional(), allergies: z.array(text(80)).max(30).optional(), notes: text(500).optional(), consent,
});
const patientUpdateSchema = patientSchema.omit({ consent: true }).partial();
const patientSearchQuery = z.object({ ...page, q: text(80).optional() });

// ---- prescriptions
const prescriptionSchema = z.object({
  branchId: objectId, patientId: objectId, externalReference: text(60).optional(), prescriptionDate: z.coerce.date(), validUntil: optDate, maxDispensings: z.coerce.number().int().min(1).max(24).optional(), minIntervalDays: z.coerce.number().int().min(0).max(365).optional(),
  prescriber: z.object({ name: text(120).min(2), registrationNumber: text(60).optional(), facility: text(120).optional(), phone: text(20).optional() }),
  items: z.array(z.object({ productId: objectId, prescribedQty: z.coerce.number().positive(), directions: text(300).optional() })).min(1).max(30),
});
const reviewSchema = z.object({ decision: z.enum(['VALIDATE', 'REJECT']), note: text().optional(), allergyChecked: z.boolean().optional() });
const interventionSchema = z.object({ type: z.enum(['CLARIFICATION', 'CHANGE_AUTHORISED', 'ALLERGY_ALERT', 'OTHER']), note: text().min(3) });
const prescriptionListQuery = z.object({ ...page, status: z.enum(['RECEIVED', 'VALIDATED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'REJECTED', 'CANCELLED', 'EXPIRED']).optional(), patientId: objectId.optional(), pendingReview: z.enum(['true', 'false']).optional().transform((v) => v === 'true'), search: text(40).optional() });

// ---- dispensing
const dispensingListQuery = z.object({ ...page, patientId: objectId.optional(), prescriptionId: objectId.optional(), dispenserId: objectId.optional(), status: z.enum(['DISPENSED', 'REVERSED']).optional(), from: optDate, to: optDate });
const labelSchema = z.object({ reason: text().optional() });
const reverseSchema = z.object({ reason: text().min(3), refundMethod: z.enum(['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER']).default('CASH') });

// ---- recall / storage
const recallSchema = z.object({ batchNumber: text(60).min(1), productId: objectId.optional(), branchId: objectId.optional(), reason: text().min(3), noticeReference: text(80).optional(), source: z.enum(['PPB', 'MANUFACTURER', 'SUPPLIER', 'INTERNAL', 'OTHER']).optional() });
const recallActionSchema = z.object({ action: text(60).min(2), note: text().optional() });
const recallCloseSchema = z.object({ note: text().optional() });
const recallListQuery = z.object({ ...page, status: z.enum(['OPEN', 'CLOSED']).optional() });
const storageLogSchema = z.object({ branchId: objectId, place: text(60).min(1), readingC: z.coerce.number().min(-50).max(80), minC: z.coerce.number().optional(), maxC: z.coerce.number().optional(), note: text().optional(), batchIds: z.array(objectId).max(100).optional() });
const flagSchema = z.object({ batchIds: z.array(objectId).min(1).max(100) });
const assessSchema = z.object({ releaseBatchIds: z.array(objectId).max(100).default([]), disposeBatchIds: z.array(objectId).max(100).default([]), note: text().min(3) });
const storageListQuery = z.object({ ...page, branchId: objectId.optional(), place: text(60).optional(), openOnly: z.enum(['true', 'false']).optional().transform((v) => v === 'true') });

// ---- reports
const dashboardQuery = z.object({ branchId: objectId.optional() });
const dispensingReportQuery = z.object({ from: optDate, to: optDate, groupBy: z.enum(['day', 'dispenser', 'medicine']).default('day'), branchId: objectId.optional() });
const rangeQuery = z.object({ from: optDate, to: optDate });
const registerQuery = z.object({ productId: objectId, branchId: objectId.optional(), from: optDate, to: optDate });
const expiryQuery = z.object({ branchId: objectId.optional(), days: z.coerce.number().int().min(1).max(365).optional() });

const approvalSchema = z.object({ licenseNumber: text(80).min(2), licenseExpiry: z.coerce.date(), note: text(300).optional() });
const supplierReturnSchema = z.object({
  branchId: objectId, supplierId: objectId, purchaseId: objectId.optional(), recallId: objectId.optional(), notes: text(500).optional(),
  lines: z.array(z.object({ batchId: objectId, quantity: z.coerce.number().positive(), reason: z.enum(['EXPIRED', 'DAMAGED', 'RECALL', 'WRONG_ITEM', 'OVERSUPPLY', 'OTHER']) })).min(1).max(100),
});
const creditSchema = z.object({ creditNoteNumber: text(60).min(1), amount: z.coerce.number().positive().transform((n) => Math.round(n * 100)) });
const returnListQuery = z.object({ supplierId: objectId.optional(), status: z.enum(['RETURNED', 'CREDITED']).optional(), ...page });
const replenishQuery = z.object({ branchId: objectId.optional(), lookbackDays: z.coerce.number().int().min(7).max(365).optional(), leadDays: z.coerce.number().int().min(0).max(120).optional(), safetyDays: z.coerce.number().int().min(0).max(120).optional() });
const accessQuery = z.object({ from: optDate, to: optDate, userId: objectId.optional() });
const exportQuery = z.object({ from: optDate, to: optDate, branchId: objectId.optional() });

const confirmClassesSchema = z.object({ statement: text(300).min(10) });
const bulkSchema = z.object({ dryRun: z.boolean().default(false), items: z.array(z.object({
  productId: objectId.optional(), sku: text(60).optional(), barcode: text(60).optional(), genericName: text(160).min(2), strength: text(60).min(1), dosageForm: text(40).min(2),
  classification: text(40).optional(), brandName: text(120).optional(), manufacturer: text(120).optional(), registrationNumber: text(80).optional(), packSize: text(80).optional(),
})).min(1).max(500) });
const returnGenerateSchema = z.object({ branchId: objectId, from: z.coerce.date(), to: z.coerce.date() });
const returnCountsSchema = z.object({ counts: z.array(z.object({ productId: objectId, countedQuantity: z.coerce.number().min(0), note: text(300).optional() })).min(1).max(200) });
const returnSignSchema = z.object({ notes: text(500).optional() });
const returnListQuery2 = z.object({ branchId: objectId.optional(), status: z.enum(['DRAFT', 'SIGNED']).optional(), ...page });
const poisonsQuery = z.object({ from: optDate, to: optDate, ...page });

module.exports = {
  confirmClassesSchema, bulkSchema, returnGenerateSchema, returnCountsSchema, returnSignSchema, returnListQuery2, poisonsQuery,
  approvalSchema, supplierReturnSchema, creditSchema, returnListQuery, replenishQuery, accessQuery, exportQuery,
  idParam, productParam, userParam, reason, medicineSchema, medicineListQuery, medicineStatusSchema, settingsSchema, credentialSchema,
  patientSchema, patientUpdateSchema, patientSearchQuery, prescriptionSchema, reviewSchema, interventionSchema, prescriptionListQuery,
  dispensingListQuery, labelSchema, reverseSchema, recallSchema, recallActionSchema, recallCloseSchema, recallListQuery,
  storageLogSchema, flagSchema, assessSchema, storageListQuery, dashboardQuery, dispensingReportQuery, rangeQuery, registerQuery, expiryQuery,
};