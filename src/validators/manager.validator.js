const { z } = require('zod');
const { objectId } = require('./common');
const overviewQuery = z.object({ branchId: objectId.optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional() });
module.exports = { overviewQuery };