
/**
 * migrate-warehouse.js
 *
 * Run after deploying the warehouse/retail stock feature.
 *
 * Usage:
 *   node scripts/migrate-warehouse.js
 *
 * MongoDB:
 *   Cluster: Pos
 *   Database: test
 *
 * Migration steps:
 *   1. Connect to MongoDB and explicitly select the test database.
 *   2. Backfill location: 'RETAIL' on existing batches,
 *      serial numbers and inventory movements without a location.
 *   3. Remove the old unique batch index that does not include location.
 *   4. Load the warehouse-related Mongoose models.
 *   5. Synchronize indexes for the warehouse-related models.
 *
 * Safety:
 *   - Does not modify stock quantities.
 *   - Does not overwrite existing location values.
 *   - Can be rerun after a partial migration.
 *   - Reports errors and disconnects after completion.
 *
 * IMPORTANT:
 *   Verify the database and collection names before production use.
 *   syncIndexes() can drop indexes absent from a model's schema.
 */

require('dotenv').config();

const mongoose = require('mongoose');

const TARGET_DATABASE = 'test';

const COLLECTIONS_TO_BACKFILL = [
  'batches',
  'serialnumbers',
  'inventorymovements',
];

const MODELS_TO_LOAD = [
  'Batch',
  'SerialNumber',
  'InventoryMovement',
  'WarehouseInventory',
  'LocationTransfer',
  'Purchase',
];

const MODELS_TO_SYNC = [
  'Batch',
  'SerialNumber',
  'InventoryMovement',
  'WarehouseInventory',
  'LocationTransfer',
];

function getMongoUri() {
  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL;

  if (!uri) {
    throw new Error(
      'MongoDB URI is missing. Check your .env file. ' +
      'Expected MONGODB_URI, MONGO_URI or DATABASE_URL.'
    );
  }

  return uri;
}

async function backfillLocations(db) {
  console.log('\n========================================');
  console.log('STEP 1: BACKFILL LOCATION FIELDS');
  console.log('========================================');

  const existingCollections = new Set(
    (
      await db.listCollections({}, { nameOnly: true }).toArray()
    ).map((collection) => collection.name)
  );

  for (const collectionName of COLLECTIONS_TO_BACKFILL) {
    if (!existingCollections.has(collectionName)) {
      console.warn(
        `WARNING: Collection "${collectionName}" does not exist. ` +
        'Skipping backfill.'
      );
      continue;
    }

    const collection = db.collection(collectionName);

    const result = await collection.updateMany(
      { location: { $exists: false } },
      { $set: { location: 'RETAIL' } }
    );

    console.log(
      `${collectionName}: ${result.modifiedCount} document(s) backfilled`
    );
  }
}

async function replaceOldBatchIndex(db) {
  console.log('\n========================================');
  console.log('STEP 2: CHECK BATCH INDEXES');
  console.log('========================================');

  const collections = await db
    .listCollections({ name: 'batches' }, { nameOnly: true })
    .toArray();

  if (collections.length === 0) {
    console.warn(
      'Batches collection does not exist yet. ' +
      'Skipping legacy index check.'
    );
    return;
  }

  const batches = db.collection('batches');
  const indexes = await batches.indexes();

  let dropped = 0;

  for (const index of indexes) {
    const keys = index.key || {};

    const isOldUniqueBatchIndex =
      index.unique === true &&
      Boolean(keys.businessId) &&
      Boolean(keys.branchId) &&
      Boolean(keys.productId) &&
      Boolean(keys.batchNumber) &&
      !Object.prototype.hasOwnProperty.call(keys, 'location');

    if (!isOldUniqueBatchIndex || index.name === '_id_') {
      continue;
    }

    console.log('Old unique batch index found:', index.name);

    await batches.dropIndex(index.name);

    console.log('Dropped old batch index:', index.name);

    dropped++;
  }

  if (dropped === 0) {
    console.log(
      'No old unique batch index found. ' +
      'It may already have been replaced.'
    );
  }
}

function loadModels() {
  console.log('\n========================================');
  console.log('STEP 3: LOAD WAREHOUSE MODELS');
  console.log('========================================');

  for (const modelName of MODELS_TO_LOAD) {
    const modelPath = `../src/models/${modelName}`;

    require(modelPath);

    console.log('Loaded model:', modelName);
  }

  for (const modelName of MODELS_TO_SYNC) {
    if (!mongoose.models[modelName]) {
      throw new Error(
        `Model "${modelName}" was not registered correctly.`
      );
    }
  }
}

async function synchronizeIndexes(db) {
  console.log('\n========================================');
  console.log('STEP 4: SYNCHRONIZE MODEL INDEXES');
  console.log('========================================');

  for (const modelName of MODELS_TO_SYNC) {
    const model = mongoose.model(modelName);

    // Ensure model operations use the explicitly selected database,
    // not the database specified by the original connection URI.
    const databaseModel =
      db.models[modelName] ||
      db.model(modelName, model.schema, model.collection.name);

    console.log(
      `Synchronizing indexes for ${modelName} ` +
      `(collection: ${databaseModel.collection.name})...`
    );

    // WARNING:
    // syncIndexes() can drop existing database indexes that are not
    // declared in the Mongoose schema. Review schemas and indexes first.
    const result = await databaseModel.syncIndexes();

    console.log(
      `Indexes synchronized: ${modelName}`,
      JSON.stringify(result)
    );
  }
}

async function main() {
  const uri = getMongoUri();

  console.log('\n========================================');
  console.log('WAREHOUSE MIGRATION');
  console.log('========================================');

  console.log('Connecting to MongoDB Atlas...');

  await mongoose.connect(uri);

  // The cluster and database are different:
  // The URI connects to the Pos cluster.
  // useDb('test') selects the test database on that connection.
  const testDb = mongoose.connection.useDb(TARGET_DATABASE, {
    useCache: true,
  });

  const db = testDb.db;

  if (!db) {
    throw new Error(
      'MongoDB connected, but the target database is unavailable.'
    );
  }

  console.log('\nConnected successfully.');
  console.log('Cluster host:', mongoose.connection.host);
  console.log('Target database:', db.databaseName);

  if (db.databaseName !== TARGET_DATABASE) {
    throw new Error(
      `Wrong database selected. Expected "${TARGET_DATABASE}", ` +
      `received "${db.databaseName}".`
    );
  }

  console.log(
    '\nIMPORTANT: Confirm this is the database containing your POS stock data.'
  );

  await backfillLocations(db);

  await replaceOldBatchIndex(db);

  loadModels();

  await synchronizeIndexes(testDb);

  console.log('\n========================================');
  console.log('WAREHOUSE MIGRATION COMPLETED');
  console.log('========================================');

  console.log('Database:', db.databaseName);
  console.log('Stock quantities modified: No');
  console.log('Existing location values overwritten: No');
}

main()
  .catch((error) => {
    console.error('\n========================================');
    console.error('WAREHOUSE MIGRATION FAILED');
    console.error('========================================');

    console.error(error.stack || error);

    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      try {
        await mongoose.disconnect();
        console.log('\nDisconnected from MongoDB.');
      } catch (error) {
        console.error('MongoDB disconnect failed:', error.message);
        process.exitCode = 1;
      }
    }
  });
