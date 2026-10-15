
/**
 * migrate-multi-warehouse.js
 *
 * Run from the POS backend root:
 *   node scripts/migrate-multi-warehouse.js
 *
 * Database:
 *   Defaults to "test".
 *   Override using MIGRATION_DB_NAME.
 *
 * Operations:
 *   1. Drop the legacy unique warehouse inventory index.
 *   2. Ensure a default warehouse exists for every business/branch
 *      with warehouse inventory.
 *   3. Attach legacy WAREHOUSE ledger records to their default
 *      warehouse using native MongoDB updates. This bypasses
 *      Mongoose immutability middleware for this migration only.
 *   4. Populate missing location-transfer kinds.
 *   5. Synchronize indexes for Warehouse, WarehouseInventory,
 *      LocationTransfer and SupplierPayment.
 *
 * Stock quantities are not intentionally changed.
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

  // This project uses "test" by default.
  const dbName = process.env.MIGRATION_DB_NAME || 'test';

  await mongoose.connect(uri, { dbName });

  console.log(`Connected to database "${mongoose.connection.name}"`);
  console.log(`Migration target: ${dbName}`);

  try {
    const Warehouse = require('../src/models/Warehouse');
    const WarehouseInventory = require('../src/models/WarehouseInventory');
    const LocationTransfer = require('../src/models/LocationTransfer');
    const SupplierPayment = require('../src/models/SupplierPayment');

    const { ensureDefaultWarehouse } = require(
      '../src/services/warehouse.resolver'
    );

    const db = mongoose.connection.db;

    if (!db) {
      throw new Error('MongoDB database connection is unavailable.');
    }

    // ---------------------------------------------------------
    // 1. Remove the legacy unique warehouse inventory index.
    // ---------------------------------------------------------
    const inventoryCollection =
      db.collection('warehouseinventories');

    try {
      const indexes = await inventoryCollection.indexes();

      for (const index of indexes) {
        const keys = Object.keys(index.key || {});

        const isLegacyUniqueIndex =
          index.unique === true &&
          keys.join(',') ===
            'businessId,branchId,productId,variantId';

        if (isLegacyUniqueIndex) {
          await inventoryCollection.dropIndex(index.name);
          console.log(`1. Dropped legacy index: ${index.name}`);
        }
      }
    } catch (error) {
      if (
        error.codeName === 'NamespaceNotFound' ||
        error.code === 26
      ) {
        console.log(
          '1. warehouseinventories collection does not exist yet; skipping legacy index removal.'
        );
      } else {
        throw error;
      }
    }

    // ---------------------------------------------------------
    // 2. Ensure a default warehouse for each business/branch
    //    that currently has warehouse inventory.
    // ---------------------------------------------------------
    const branchPairs = await WarehouseInventory.aggregate([
      {
        $group: {
          _id: {
            businessId: '$businessId',
            branchId: '$branchId'
          }
        }
      }
    ]);

    const branchWarehouses = [];

    for (const pair of branchPairs) {
      const { businessId, branchId } = pair._id;

      if (businessId == null || branchId == null) {
        console.warn(
          '2. Skipping an inventory group with a missing businessId or branchId.'
        );
        continue;
      }

      const warehouse = await ensureDefaultWarehouse(
        businessId,
        branchId,
        undefined,
        undefined
      );

      if (!warehouse || !warehouse._id) {
        throw new Error(
          `Could not ensure a default warehouse for branch ${String(branchId)}`
        );
      }

      branchWarehouses.push({
        businessId,
        branchId,
        warehouseId: warehouse._id
      });

      console.log(
        `2. Default warehouse ensured for branch ${String(branchId)}: ${String(warehouse._id)}`
      );
    }

    console.log(
      `2. Processed ${branchWarehouses.length} business/branch pair(s).`
    );

    // ---------------------------------------------------------
    // 3. Backfill legacy WAREHOUSE inventory ledger records.
    //
    // InventoryMovement.js prevents Mongoose updates to
    // immutable records. Use the native MongoDB collection
    // for this targeted, one-time metadata backfill.
    //
    // Scope updates by businessId and branchId. Only records
    // with a missing or null warehouseId are modified.
    // Stock quantities are not changed.
    // ---------------------------------------------------------
    const movementCollection =
      db.collection('inventorymovements');

    let tagged = 0;

    for (const entry of branchWarehouses) {
      const result = await movementCollection.updateMany(
        {
          businessId: entry.businessId,
          branchId: entry.branchId,
          location: 'WAREHOUSE',
          $or: [
            { warehouseId: { $exists: false } },
            { warehouseId: null }
          ]
        },
        {
          $set: {
            warehouseId: entry.warehouseId
          }
        }
      );

      tagged += result.modifiedCount || 0;
    }

    console.log(`3. Tagged ${tagged} warehouse ledger row(s).`);

    // ---------------------------------------------------------
    // 4. Populate missing location-transfer kinds.
    // ---------------------------------------------------------
    const toRetail = await LocationTransfer.updateMany(
      {
        kind: { $exists: false },
        fromLocation: 'WAREHOUSE',
        toLocation: 'RETAIL'
      },
      {
        $set: { kind: 'TO_RETAIL' }
      }
    );

    const toWarehouse = await LocationTransfer.updateMany(
      {
        kind: { $exists: false },
        fromLocation: 'RETAIL',
        toLocation: 'WAREHOUSE'
      },
      {
        $set: { kind: 'TO_WAREHOUSE' }
      }
    );

    const transferCount =
      (toRetail.modifiedCount || 0) +
      (toWarehouse.modifiedCount || 0);

    console.log(
      `4. Set transfer kind on ${transferCount} document(s).`
    );

    // ---------------------------------------------------------
    // 5. Synchronize indexes from the current model schemas.
    //
    // WARNING: syncIndexes() may drop database indexes that
    // are not defined in the corresponding Mongoose schemas.
    // ---------------------------------------------------------
    const models = [
      Warehouse,
      WarehouseInventory,
      LocationTransfer,
      SupplierPayment
    ];

    for (const model of models) {
      await model.syncIndexes();
      console.log(
        `5. Indexes synchronized: ${model.modelName}`
      );
    }

    console.log(
      'Migration completed. Stock quantities were not intentionally changed.'
    );
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
