'use strict';
/** One registry for every kind of event a till can push, so push-sync and "release from quarantine" share the same code path. */
const v = require('../validators/sync.validator');
const { ingestOfflineSale } = require('./offline-sale.service');
const { ingestShiftOpen, ingestShiftClose } = require('./offline-shift.service');

const REGISTRY = {
  SALE: { schema: v.offlineSaleSchema, ref: (d) => d.clientTransactionId, seq: (d) => d.localSeq, at: (d) => d.soldAt, run: (c) => ingestOfflineSale({ ...c, sale: c.data }) },
  SHIFT_OPEN: { schema: v.shiftOpenSchema, ref: (d) => d.clientEventId, seq: () => undefined, at: (d) => d.occurredAt, run: (c) => ingestShiftOpen({ ...c, event: c.data }) },
  SHIFT_CLOSE: { schema: v.shiftCloseSchema, ref: (d) => d.clientEventId, seq: () => undefined, at: (d) => d.occurredAt, run: (c) => ingestShiftClose({ ...c, event: c.data }) },
};

const typeOf = (raw) => (raw && typeof raw.type === 'string' ? raw.type : 'SALE');

module.exports = { REGISTRY, typeOf };