/**
 * migrate-sale-index.js
 *
 * PROBLEM:
 * A leftover compound index exists on the `sales` collection:
 *
 *   businessId + branchId + deviceId + clientTransactionId
 *
 * This migration finds that specific index and drops ONLY that index.
 *
 * It does not modify or delete any sales data.
 *
 * Usage:
 *   node migrate-sale-index.js
 *
 * Requires:
 *   MONGODB_URI=your-connection-string
 *
 * in your .env file.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const OFFENDING_KEYS = {
  businessId: 1,
  branchId: 1,
  deviceId: 1,
  clientTransactionId: 1,
};

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error(
      'MONGODB_URI is not set. Set it in your environment or .env file and try again.'
    );
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');

  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  const collection = db.collection('sales');

  console.log('\nCurrent indexes on the "sales" collection:');

  const indexes = await collection.indexes();

  indexes.forEach((idx) => {
    console.log(
      `  - ${idx.name}:`,
      JSON.stringify(idx.key),
      idx.unique ? '(unique)' : ''
    );
  });

  // Find the exact compound index.
  const badIndex = indexes.find((idx) => {
    if (!idx.key) return false;

    const keys = Object.keys(idx.key);

    const expectedKeys = Object.keys(OFFENDING_KEYS);

    if (keys.length !== expectedKeys.length) {
      return false;
    }

    return expectedKeys.every(
      (key) => idx.key[key] === OFFENDING_KEYS[key]
    );
  });

  if (!badIndex) {
    console.log(
      '\nOld sale index not found. Nothing to do.'
    );

    console.log(
      'If sales are still failing with a duplicate-key error,'
    );

    console.log(
      'share the index list above so the offending index can be identified.'
    );

    await mongoose.disconnect();
    return;
  }

  console.log(
    `\nFound the targeted index: "${badIndex.name}"`
  );

  console.log(
    'Key:',
    JSON.stringify(badIndex.key)
  );

  console.log(
    badIndex.unique
      ? 'Type: UNIQUE'
      : 'Type: NON-UNIQUE'
  );

  console.log('\nDropping the targeted index...');

  await collection.dropIndex(badIndex.name);

  console.log(
    `Dropped "${badIndex.name}".`
  );

  console.log('\nIndexes on "sales" after the fix:');

  const after = await collection.indexes();

  after.forEach((idx) => {
    console.log(
      `  - ${idx.name}:`,
      JSON.stringify(idx.key),
      idx.unique ? '(unique)' : ''
    );
  });

  console.log(
    '\nDone. The old sale index has been removed.'
  );

  console.log(
    'Restart the application so Mongoose can create the current schema indexes.'
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('\nScript failed:', err);

  try {
    await mongoose.disconnect();
  } catch (_) {
    // Ignore disconnect errors.
  }

  process.exit(1);
});
