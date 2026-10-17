
/**
 * backfill-receipt-verify-tokens.js
 *
 * Run from the POS backend root:
 *   node scripts/backfill-receipt-verify-tokens.js
 *
 * Database:
 *   Defaults to "test".
 *   Override with MIGRATION_DB_NAME.
 *
 * Purpose:
 *   Generate verification tokens for existing receipts that do
 *   not have one. New receipts should receive tokens automatically.
 *
 * Safe to rerun: receipts with existing tokens are not modified.
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL;

  if (!uri) {
    throw new Error(
      'MongoDB URI is missing. Set MONGODB_URI, MONGO_URI, or DATABASE_URL.'
    );
  }

  const dbName = process.env.MIGRATION_DB_NAME || 'test';

  await mongoose.connect(uri, { dbName });

  console.log(`Connected to database "${mongoose.connection.name}"`);
  console.log(`Migration target: ${dbName}`);

  try {
    // Load models only after connecting to the selected database.
    const Receipt = require('../src/models/Receipt');
    const { newVerifyToken } = require('../src/utils/receiptToken');

    // Synchronize schema indexes. This may drop indexes not defined
    // in the current Receipt schema, so review custom indexes first.
    try {
      await Receipt.syncIndexes();
      console.log('Receipt indexes synchronized.');
    } catch (error) {
      console.warn('Receipt index sync warning:', error.message);
    }

    const noToken = {
      $or: [
        { verifyToken: { $exists: false } },
        { verifyToken: null }
      ]
    };

    const cursor = Receipt.find(noToken)
      .select('_id')
      .lean()
      .cursor();

    let batch = [];
    let processed = 0;
    let matched = 0;

    const flush = async () => {
      if (batch.length === 0) return;

      const operations = batch.map((receiptId) => ({
        updateOne: {
          // Recheck the missing-token condition to avoid overwriting
          // a token created by another process after the read.
          filter: {
            _id: receiptId,
            ...noToken
          },
          update: {
            $set: {
              verifyToken: newVerifyToken()
            }
          }
        }
      }));

      const result = await Receipt.bulkWrite(operations, {
        ordered: false
      });

      matched += result.matchedCount || 0;
      processed += result.modifiedCount || 0;

      console.log(
        `Progress: ${processed} receipt(s) assigned verification tokens.`
      );

      batch = [];
    };

    for await (const receipt of cursor) {
      batch.push(receipt._id);

      if (batch.length >= 500) {
        await flush();
      }
    }

    await flush();

    console.log(`Receipts matched for backfill: ${matched}`);
    console.log(`Receipts given a verification token: ${processed}`);
    console.log('Receipt verification token backfill completed.');
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  }
}

main().catch((error) => {
  console.error('Receipt token migration failed:', error);
  process.exitCode = 1;
});
