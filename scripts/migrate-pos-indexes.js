
/**
 * migrate-pos-indexes.js
 *
 * Performs the following migrations in the "test" database:
 * 1. Inspects sales indexes and removes the old compound sparse index
 *    only if its signature matches the expected old index.
 * 2. Creates the new partial unique sales index.
 * 3. Replaces the cashiershortages shiftId_1 index.
 * 4. Creates the cashiershortages claimId index.
 * 5. Backfills soldAt from createdAt where soldAt is missing.
 *
 * Usage from the posbackend directory:
 *   node scripts/migrate-pos-indexes.js
 *
 * Requires MONGODB_URI in your .env file.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const SALES_INDEX_KEYS = {
  businessId: 1,
  branchId: 1,
  deviceId: 1,
  clientTransactionId: 1,
};

const SALES_PARTIAL_FILTER = {
  deviceId: { $type: 'string' },
  clientTransactionId: { $type: 'string' },
};

async function main() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('MONGODB_URI is not set in your .env file.');
  }

  // Connect using the URI in .env.
  await mongoose.connect(uri);

  console.log('Connected to MongoDB.');

  // IMPORTANT: The cluster is named "Pos", but the database is "test".
  const db = mongoose.connection.useDb('test').db;

  console.log('Connected database:', db.databaseName);

  const sales = db.collection('sales');
  const shortages = db.collection('cashiershortages');

  try {
    // Confirm that the expected collections exist before modifying indexes.
    const collectionNames = await db
      .listCollections({}, { nameOnly: true })
      .toArray();

    const existingCollections = collectionNames.map(
      (collection) => collection.name
    );

    if (!existingCollections.includes('sales')) {
      throw new Error(
        'The sales collection was not found in the test database. ' +
        'Migration stopped without modifying indexes.'
      );
    }

    if (!existingCollections.includes('cashiershortages')) {
      throw new Error(
        'The cashiershortages collection was not found in the test database. ' +
        'Migration stopped without modifying indexes.'
      );
    }

    // 1. Inspect current sales indexes.
    console.log('\nCurrent sales indexes:');

    let salesIndexes = await sales.indexes();

    salesIndexes.forEach((idx) => {
      console.log(
        idx.name,
        JSON.stringify(idx.key),
        JSON.stringify({
          unique: idx.unique,
          sparse: idx.sparse,
          partialFilterExpression: idx.partialFilterExpression,
        })
      );
    });

    // 2. Find the compound index with the expected key pattern.
    const oldIndex = salesIndexes.find((idx) => {
      if (!idx.key) return false;

      const keys = Object.keys(idx.key);
      const expectedKeys = Object.keys(SALES_INDEX_KEYS);

      return (
        keys.length === expectedKeys.length &&
        expectedKeys.every(
          (key) => idx.key[key] === SALES_INDEX_KEYS[key]
        )
      );
    });

    if (oldIndex) {
      const isOldSparseIndex =
        oldIndex.sparse === true &&
        !oldIndex.partialFilterExpression;

      if (isOldSparseIndex) {
        console.log(
          `\nDropping old sparse sales index: ${oldIndex.name}`
        );

        await sales.dropIndex(oldIndex.name);

        console.log('Old sales index dropped.');
      } else {
        console.log(
          `\nFound sales index "${oldIndex.name}", but it does not ` +
          'match the old sparse-index signature.'
        );

        console.log('Leaving that index unchanged.');
      }
    } else {
      console.log('\nOld compound sales index not found.');
    }

    // 3. Create the new partial unique sales index if absent.
    salesIndexes = await sales.indexes();

    const desiredSalesIndex = salesIndexes.find((idx) => {
      const sameKeys =
        JSON.stringify(idx.key) ===
        JSON.stringify(SALES_INDEX_KEYS);

      const samePartialFilter =
        JSON.stringify(idx.partialFilterExpression) ===
        JSON.stringify(SALES_PARTIAL_FILTER);

      return idx.unique === true && sameKeys && samePartialFilter;
    });

    if (!desiredSalesIndex) {
      console.log('\nCreating the partial unique sales index...');

      await sales.createIndex(SALES_INDEX_KEYS, {
        name: 'business_branch_device_clientTxn_partial_unique',
        unique: true,
        partialFilterExpression: SALES_PARTIAL_FILTER,
      });

      console.log('Created partial unique sales index.');
    } else {
      console.log('\nDesired sales index already exists.');
    }

    // 4. Inspect current cashier shortages indexes.
    console.log('\nCurrent cashiershortages indexes:');

    let shortageIndexes = await shortages.indexes();

    shortageIndexes.forEach((idx) => {
      console.log(
        idx.name,
        JSON.stringify(idx.key),
        JSON.stringify({
          unique: idx.unique,
          sparse: idx.sparse,
          partialFilterExpression: idx.partialFilterExpression,
        })
      );
    });

    // 5. Replace shiftId_1 if it exists.
    shortageIndexes = await shortages.indexes();

    const oldShiftIndex = shortageIndexes.find(
      (idx) => idx.name === 'shiftId_1'
    );

    if (oldShiftIndex) {
      console.log('\nDropping cashiershortages index shiftId_1...');

      await shortages.dropIndex('shiftId_1');

      console.log('Dropped shiftId_1.');
    } else {
      console.log('\nIndex shiftId_1 not found.');
    }

    // Create the partial unique shiftId index if absent.
    shortageIndexes = await shortages.indexes();

    const shiftIndexExists = shortageIndexes.some((idx) => {
      return (
        idx.unique === true &&
        idx.key?.shiftId === 1 &&
        Object.keys(idx.key).length === 1 &&
        idx.partialFilterExpression?.shiftId?.$type === 'objectId'
      );
    });

    if (!shiftIndexExists) {
      console.log('\nCreating shiftId partial unique index...');

      await shortages.createIndex(
        { shiftId: 1 },
        {
          name: 'shiftId_objectId_partial_unique',
          unique: true,
          partialFilterExpression: {
            shiftId: { $type: 'objectId' },
          },
        }
      );

      console.log('Created shiftId partial unique index.');
    } else {
      console.log('\nDesired shiftId index already exists.');
    }

    // 6. Create the partial unique claimId index if absent.
    shortageIndexes = await shortages.indexes();

    const claimIndexExists = shortageIndexes.some((idx) => {
      return (
        idx.unique === true &&
        idx.key?.claimId === 1 &&
        Object.keys(idx.key).length === 1 &&
        idx.partialFilterExpression?.claimId?.$type === 'objectId'
      );
    });

    if (!claimIndexExists) {
      console.log('\nCreating claimId partial unique index...');

      await shortages.createIndex(
        { claimId: 1 },
        {
          name: 'claimId_objectId_partial_unique',
          unique: true,
          partialFilterExpression: {
            claimId: { $type: 'objectId' },
          },
        }
      );

      console.log('Created claimId partial unique index.');
    } else {
      console.log('\nDesired claimId index already exists.');
    }

    // 7. Backfill soldAt from createdAt where soldAt is missing.
    console.log('\nBackfilling missing soldAt values...');

    const result = await sales.updateMany(
      { soldAt: { $exists: false } },
      [
        {
          $set: {
            soldAt: '$createdAt',
          },
        },
      ]
    );

    console.log(`Matched sales: ${result.matchedCount}`);
    console.log(`Updated sales: ${result.modifiedCount}`);

    // 8. Display final sales indexes.
    console.log('\nFinal sales indexes:');

    const finalSalesIndexes = await sales.indexes();

    finalSalesIndexes.forEach((idx) => {
      console.log(
        idx.name,
        JSON.stringify(idx.key),
        JSON.stringify({
          unique: idx.unique,
          sparse: idx.sparse,
          partialFilterExpression: idx.partialFilterExpression,
        })
      );
    });

    // 9. Display final cashier shortages indexes.
    console.log('\nFinal cashiershortages indexes:');

    const finalShortageIndexes = await shortages.indexes();

    finalShortageIndexes.forEach((idx) => {
      console.log(
        idx.name,
        JSON.stringify(idx.key),
        JSON.stringify({
          unique: idx.unique,
          sparse: idx.sparse,
          partialFilterExpression: idx.partialFilterExpression,
        })
      );
    });

    console.log('\nMigration completed successfully.');
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exitCode = 1;
});
