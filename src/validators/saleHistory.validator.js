/** Query schemas for the Reports > All sales endpoints (routes/report.routes.js). List filters are comma separated. */
const { z } = require('zod');
const { objectId } = require('./common');

const str = (n = 120) => z.string().trim().max(n);
const flag = z.enum(['0', '1']);

const list = z.object({
  branchId: objectId.optional(), cashierId: objectId.optional(), customerId: objectId.optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(),
  search: str(100).optional(),
  saleStatus: z.enum(['COMPLETED', 'CANCELLED', 'ALL']).default('ALL'),
  paymentStatus: str(80).optional(), method: str(120).optional(), channel: str(40).optional(), source: str(120).optional(),
  customerType: z.enum(['ALL', 'WALKIN', 'REGISTERED']).default('ALL'),
  hasDiscount: flag.optional(), hasRefund: flag.optional(), hasBalance: flag.optional(), offline: flag.optional(), flagged: flag.optional(),
  minTotal: z.coerce.number().min(0).optional(), maxTotal: z.coerce.number().min(0).optional(),
  sort: z.enum(['newest', 'oldest', 'highest', 'lowest', 'receipt']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

const idParam = z.object({ id: objectId });

module.exports = { list, idParam };
