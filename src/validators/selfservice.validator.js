const { z } = require('zod');
const { objectId } = require('./common');
const { toCents } = require('../utils/money');

const str = (n = 200) => z.string().trim().max(n);
const tokenParam = z.object({ token: z.string().min(30).max(80) });
const codeParam = z.object({ token: z.string().min(30).max(80), code: z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/) });
const modSel = z.object({ groupId: objectId, optionId: objectId, quantity: z.coerce.number().int().min(1).max(20).optional() });
const cartItem = z.object({
  menuItemId: objectId, quantity: z.coerce.number().int().min(1).max(50), variantId: objectId.optional(), modifiers: z.array(modSel).max(30).optional(),
  comboPicks: z.array(z.object({ groupId: objectId, menuItemId: objectId, quantity: z.coerce.number().int().min(1).optional(), variantId: objectId.optional() })).max(20).optional(),
  notes: str(200).optional(),
}).strict();
const base = { orderType: z.enum(['DINE_IN', 'TAKEAWAY']), tableId: objectId.optional(), items: z.array(cartItem).min(1).max(60) };   // prices / totals / business are NEVER accepted from the browser

const menuQuery = z.object({ orderType: z.enum(['DINE_IN', 'TAKEAWAY']).optional() });
const quoteBody = z.object(base).strict();
const orderBody = z.object({
  ...base, paymentMethod: z.enum(['MPESA', 'CASH']), phone: str(20).optional(), customerName: str(60).optional(),
  clientRef: z.string().trim().min(8).max(80),                      // one per checkout press: a double tap returns the same order
}).strict();
const mpesaBody = z.object({ phone: str(20).min(9) }).strict();

// ---- staff side
const staffList = z.object({ branchId: objectId.optional(), search: str(40).optional(), state: z.enum(['PENDING', 'AWAITING_CASH', 'PAID', 'EXPIRED']).optional() });
const confirmCashBody = z.object({ tendered: z.coerce.number().min(0).transform(toCents).optional() }).strict();   // typed in major units, stored as cents

module.exports = { tokenParam, codeParam, menuQuery, quoteBody, orderBody, mpesaBody, staffList, confirmCashBody };
