/** Query schemas for the order / delivery / guest history endpoints (routes/restaurant.routes.js). All lists are comma separated. */
const { z } = require('zod');
const { objectId } = require('./common');

const str = (n = 120) => z.string().trim().max(n);
const date = z.coerce.date();
const num = z.coerce.number().min(0);
const paging = { page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(25) };

const orders = z.object({
  branchId: objectId.optional(),
  from: date.optional(), to: date.optional(),
  dateField: z.enum(['createdAt', 'closedAt', 'deliveredAt', 'collectedAt']).default('createdAt'),
  search: str(100).optional(),
  orderType: str(120).optional(), source: str(120).optional(), status: str(60).optional(), billStatus: str(80).optional(),
  deliveryStatus: str(120).optional(), paymentMethod: str(120).optional(),
  scope: z.enum(['all', 'delivery', 'pickup', 'qr', 'kiosk']).default('all'),
  outcome: z.enum(['DONE', 'FAILED', 'CANCELLED', 'ACTIVE', 'ALL']).optional(),
  tableId: objectId.optional(), waiterId: objectId.optional(), riderId: objectId.optional(),
  minTotal: num.optional(), maxTotal: num.optional(),
  mine: z.enum(['0', '1']).optional(),
  sort: z.enum(['newest', 'oldest', 'highest', 'lowest', 'number']).default('newest'),
  facets: z.enum(['0', '1']).optional(),
  ...paging,
});

const guest = z.object({
  branchId: objectId.optional(),
  type: z.enum(['requests', 'calls']).default('requests'),
  from: date.optional(), to: date.optional(),
  search: str(100).optional(), status: str(120).optional(), kind: str(120).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  ...paging,
});

module.exports = { orders, guest };
