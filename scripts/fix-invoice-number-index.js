/**
 * fix-invoice-number-index.js
 *
 * PROBLEM: a leftover unique index on `invoice_number` (snake_case) exists
 * on the `sales` collection - almost certainly from an earlier manual test
 * or seed, predating the current schema. The current schema only ever
 * writes `invoiceNumber` (camelCase) and never indexes it uniquely, so
 * every inserted Sale document is treated by that stray index as having
 * `invoice_number: null`. A unique index allows exactly ONE document with
 * a missing/null value, so the first sale after the index was created
 * succeeds and every sale after that fails with a duplicate-key error.
 *
 * This script is READ-ONLY except for the one targeted drop: it lists
 * every index on `sales`, finds any whose key is exactly `invoice_number`
 * (not `invoiceNumber` - your real schema field is left completely alone),
 * prints what it found, and drops ONLY that index. It touches no data.
 *
 * Usage (from the pos-backend directory, with your real MONGODB_URI):
 *   MONGODB_URI="your-connection-string" node scripts/fix-invoice-number-index.js
 * or, if you already have a .env file with MONGODB_URI set:
 *   node scripts/fix-invoice-number-index.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const OFFENDING_KEY = 'invoice_number'; // snake_case - NOT our schema's invoiceNumber

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Set it in your environment or .env file and try again.');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const collection = db.collection('sales');

  console.log('\nCurrent indexes on the "sales" collection:');
  const indexes = await collection.indexes();
  indexes.forEach((idx) => console.log(`  - ${idx.name}:`, JSON.stringify(idx.key), idx.unique ? '(unique)' : ''));

  const stray = indexes.find((idx) => Object.prototype.hasOwnProperty.call(idx.key, OFFENDING_KEY));

  if (!stray) {
    console.log(`\nNo index on "${OFFENDING_KEY}" found. Nothing to do - if sales are still failing with`);
    console.log('a duplicate-key error, run this script again and share the index list above so we can');
    console.log('identify the actual offending index name/key.');
    await mongoose.disconnect();
    return;
  }

  console.log(`\nFound the stray index: "${stray.name}" on key ${JSON.stringify(stray.key)}${stray.unique ? ' (unique)' : ''}`);
  console.log('Dropping it now...');
  await collection.dropIndex(stray.name);
  console.log(`Dropped "${stray.name}".`);

  console.log('\nIndexes on "sales" after the fix:');
  const after = await collection.indexes();
  after.forEach((idx) => console.log(`  - ${idx.name}:`, JSON.stringify(idx.key), idx.unique ? '(unique)' : ''));

  console.log('\nDone. Sales should now work for every cashier, not just the first one per deployment.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
