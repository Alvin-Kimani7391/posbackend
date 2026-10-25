const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');

const str = (n = 200) => z.string().trim().max(n);
const money0 = z.coerce.number().min(0).transform(toCents);
const lat = z.coerce.number().min(-90).max(90); const lng = z.coerce.number().min(-180).max(180);
const battery = z.object({ level: z.coerce.number().min(0).max(1), charging: z.coerce.boolean().optional() });
const idParam = z.object({ id: objectId });

// ---- public rider QR page
const loginBody = z.object({
  identifier: str(120).min(3).optional(), password: z.string().min(1).max(200).optional(),
  employeeCode: str(30).min(1).optional(), pin: z.string().min(3).max(12).optional(),
}).strict().refine((b) => (b.employeeCode && b.pin) || (b.identifier && b.password), { message: 'Enter your phone and password, or your employee code and PIN' });

// ---- rider app
const location = z.object({ lat, lng, accuracy: z.coerce.number().min(0).max(100000).optional(), heading: z.coerce.number().min(0).max(360).optional(), speed: z.coerce.number().min(0).max(100).optional(), battery: battery.optional(), recordedAt: z.string().optional() }).strict();
const online = z.object({ online: z.boolean(), lat: lat.optional(), lng: lng.optional(), battery: battery.optional(), device: str(120).optional() }).strict();
const here = z.object({ lat: lat.optional(), lng: lng.optional() }).strict();
const failBody = z.object({ reason: str(200).min(3) }).strict();
const listQuery = z.object({ tab: z.enum(['active', 'completed']).optional(), page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
const earningsQuery = z.object({ period: z.enum(['today', 'week', 'month']).optional() });
const mpesaBody = z.object({ phone: str(20).min(9).optional() }).strict();
const cashBody = z.object({ tendered: money0.optional() }).strict();
const referenceParam = z.object({ reference: z.string().regex(/^[A-Za-z0-9_-]{6,60}$/) });
const pushBody = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(100) }) }).strict();

// ---- staff (owner / manager / cashier)
const branchQuery = z.object({ branchId: objectId.optional() });
const handoverBody = z.object({ riderId: objectId, collectionIds: z.array(objectId).max(100).optional(), receivedAmount: money0.optional(), note: str(300).optional() }).strict();
const historyQuery = z.object({ branchId: objectId.optional(), riderId: objectId.optional(), page: z.coerce.number().int().min(1).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
const ticketBody = z.object({ scope: z.enum(['rider', 'staff']).optional() }).strict().optional();
const streamQuery = z.object({ ticket: z.string().min(20).max(1000), branchId: objectId.optional() });

// ---- customer (public)
const trackParams = z.object({ token: z.string().max(120), key: z.string().regex(/^[a-f0-9]{16}$/) });
const liveQuery = z.object({ since: z.string().max(40).optional() });
const moveBody = z.object({ lat, lng }).strict();
const rateBody = z.object({ stars: z.coerce.number().int().min(1).max(5), comment: str(300).optional() }).strict();

module.exports = { idParam, loginBody, location, online, here, failBody, listQuery, earningsQuery, mpesaBody, cashBody, referenceParam, pushBody, branchQuery, handoverBody, historyQuery, ticketBody, streamQuery, trackParams, liveQuery, moveBody, rateBody };
