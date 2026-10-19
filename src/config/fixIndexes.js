/**
 * fixIndexes.js - one-time, idempotent repair of unique indexes that were created with `sparse: true` on a COMPOUND key.
 *
 * Why: a compound sparse index still indexes a document that is missing one of its fields (businessId always exists), so
 * "unique + sparse" on { businessId, barcode } allowed only ONE product without a barcode per business. Every restaurant dish
 * (and every hidden system product) is a product without a barcode, so the 2nd dish failed with "That barcode is already in use".
 *
 * What it does on every start: for each index below, if the live index is not the partial version, drop it and create the
 * partial one. If it is already right, nothing happens. Failures are logged and never stop the server.
 */
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const FIXES = [
  { collection: 'products', field: 'barcode' },
  { collection: 'productvariants', field: 'barcode' },
  { collection: 'users', field: 'email' },
  { collection: 'users', field: 'employeeCode' },
  { collection: 'customers', field: 'customerNumber' },
];

async function fixOne(db, { collection, field }) {
  const col = db.collection(collection);
  let indexes;
  try { indexes = await col.indexes(); } catch (e) { if (/ns does not exist|NamespaceNotFound/i.test(e.message)) return 'no-collection'; throw e; }
  const want = { businessId: 1, [field]: 1 };
  const same = (k) => JSON.stringify(k) === JSON.stringify(want);
  const current = indexes.find((i) => same(i.key));
  const isPartial = (i) => i && i.partialFilterExpression && i.unique;
  if (isPartial(current)) return 'ok';
  if (current) await col.dropIndex(current.name);
  await col.createIndex(want, { unique: true, partialFilterExpression: { [field]: { $type: 'string' } } });
  return current ? 'repaired' : 'created';
}

async function fixSparseCompoundIndexes() {
  const db = mongoose.connection.db;
  for (const f of FIXES) {
    try {
      const r = await fixOne(db, f);
      if (r === 'repaired' || r === 'created') logger.info(`Index ${f.collection}.{businessId,${f.field}}: ${r}`);
    } catch (err) {
      logger.warn(`Index repair skipped for ${f.collection}.${f.field}`, { error: err.message });
    }
  }
}

module.exports = { fixSparseCompoundIndexes };
