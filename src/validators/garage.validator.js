const { z } = require('zod');
const { objectId, paginationQuery } = require('./common');
const { toCents } = require('../utils/money');

const positiveMoney = z.coerce.number().positive().transform(toCents);
const idParamSchema = z.object({ id: objectId });
const partParamSchema = z.object({ id: objectId, partId: objectId });
const labourParamSchema = z.object({ id: objectId, labourId: objectId });
const reason = z.string().trim().min(3, 'Give a reason');
const km = z.coerce.number().int().min(0).max(5000000);

// ---- vehicles
const vehicleBody = {
  customerId: objectId.optional(),
  ownerName: z.string().trim().min(2).max(120).optional(),
  ownerPhone: z.string().trim().min(7).max(20).optional(),
  plate: z.string().trim().min(3).max(15),
  vin: z.string().trim().max(30).optional(),
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().max(80).optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  color: z.string().trim().max(40).optional(),
  engineNo: z.string().trim().max(40).optional(),
  fuelType: z.enum(['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC', 'OTHER']).optional(),
  transmission: z.enum(['MANUAL', 'AUTOMATIC', 'OTHER']).optional(),
  odometerKm: km.optional(),
  insuranceExpiry: z.coerce.date().optional(),
  notes: z.string().trim().max(1000).optional(),
};
const createVehicleSchema = z.object(vehicleBody);
const updateVehicleSchema = z.object({
  ...Object.fromEntries(Object.entries(vehicleBody).map(([k, s]) => [k, s.optional()])),
  vin: z.string().trim().max(30).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
}).partial();
const vehicleLookupQuery = z.object({ plate: z.string().trim().min(3).max(15).optional(), vin: z.string().trim().min(5).max(30).optional() })
  .refine((q) => q.plate || q.vin, { message: 'Give a plate or VIN' });
const vehicleListQuery = paginationQuery.extend({ customerId: objectId.optional(), search: z.string().trim().max(60).optional(), status: z.enum(['active', 'inactive']).optional() });
const historyQuery = paginationQuery;
const dueQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(14), kmWindow: z.coerce.number().int().min(0).max(10000).default(500) });

// ---- job cards
const createJobCardSchema = z.object({
  branchId: objectId,
  vehicleId: objectId,
  customerId: objectId.optional(),
  customerName: z.string().trim().min(2).max(120).optional(),
  customerPhone: z.string().trim().min(7).max(20).optional(),
  odometerIn: km,
  fuelLevel: z.enum(['EMPTY', 'QUARTER', 'HALF', 'THREE_QUARTER', 'FULL']).optional(),
  conditionNotes: z.string().trim().max(1000).optional(),
  itemsLeftInCar: z.array(z.string().trim().max(60)).max(20).optional(),
  customerSuppliedParts: z.array(z.string().trim().max(80)).max(20).optional(),
  complaint: z.string().trim().min(3).max(1000),
  mechanicId: objectId.optional(),
  promisedDate: z.coerce.date().optional(),
  isWarrantyRepair: z.boolean().optional().default(false),
});
const estimateSchema = z.object({
  diagnosis: z.string().trim().max(1000).optional(),
  mechanicId: objectId.optional(),
  promisedDate: z.coerce.date().optional(),
  customerSuppliedParts: z.array(z.string().trim().max(80)).max(20).optional(),
  addLabour: z.array(z.object({
    description: z.string().trim().min(2).max(200),
    hours: z.coerce.number().min(0.1).max(100).optional(),
    rate: positiveMoney, // per hour; use hours = 1 for a fixed price
    mechanicId: objectId.optional(),
  })).max(30).optional(),
  removeLabourIds: z.array(objectId).max(30).optional(),
  addParts: z.array(z.object({ productId: objectId, variantId: objectId.optional(), quantity: z.coerce.number().positive() })).max(50).optional(),
  removePartIds: z.array(objectId).max(50).optional(),
});
const approvalSchema = z.object({ channel: z.enum(['IN_PERSON', 'PHONE', 'SMS', 'WHATSAPP']), note: z.string().trim().max(300).optional() });
const labourDoneSchema = z.object({ done: z.boolean().optional().default(true) });
const actionSchema = z.object({ action: z.enum(['startWork', 'awaitParts', 'sendToQualityCheck']), note: z.string().trim().max(300).optional() });
const qcSchema = z.object({ passed: z.boolean(), note: z.string().trim().max(500).optional(), roadTest: z.boolean().optional().default(false) });
const cancelSchema = z.object({ reason });
const paymentSchema = z.object({
  type: z.enum(['DEPOSIT', 'PAYMENT', 'REFUND']),
  method: z.enum(['CASH', 'MPESA', 'CARD', 'BANK', 'OTHER']),
  amount: positiveMoney,
  reference: z.string().trim().max(100).optional(),
});
const collectSchema = z.object({
  collectedByName: z.string().trim().min(2).max(120),
  idChecked: z.boolean().optional().default(false),
  odometerOut: km,
  workWarrantyDays: z.coerce.number().int().min(0).max(730).optional().default(0),
  nextServiceKm: km.optional(),
  nextServiceDate: z.coerce.date().optional(),
  waiveBalance: z.boolean().optional().default(false),
  waiveReason: z.string().trim().max(300).optional(),
});
const jobCardListQuery = paginationQuery.extend({
  branchId: objectId.optional(), vehicleId: objectId.optional(), mechanicId: objectId.optional(), search: z.string().trim().max(60).optional(),
  status: z.enum(['CHECKED_IN', 'DIAGNOSED', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_PARTS', 'IN_PROGRESS', 'QUALITY_CHECK', 'READY', 'COLLECTED', 'CANCELLED']).optional(),
  overdue: z.coerce.boolean().optional(),
});
const summaryQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), branchId: objectId.optional() });
const uncollectedQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(7), branchId: objectId.optional() });

module.exports = {
  idParamSchema, partParamSchema, labourParamSchema,
  createVehicleSchema, updateVehicleSchema, vehicleLookupQuery, vehicleListQuery, historyQuery, dueQuery,
  createJobCardSchema, estimateSchema, approvalSchema, labourDoneSchema, actionSchema, qcSchema, cancelSchema, paymentSchema, collectSchema,
  jobCardListQuery, summaryQuery, uncollectedQuery,
};