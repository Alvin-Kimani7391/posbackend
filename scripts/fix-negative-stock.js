
/**
 * fix-negative-stock.js
 *
 * Run from the POS backend root:
 *   node scripts/fix-negative-stock.js                 (dry run)
 *   node scripts/fix-negative-stock.js --apply         (apply changes)
 *
 * Options:
 *   --business <id>    limit to one business
 *
 * Database:
 *   Defaults to "test".
 *   Override using MIGRATION_DB_NAME.
 *
 * Operations:
 *   1. Correct negative retail and warehouse stock to 0.
 *      Creates a normal ADJUSTMENT_IN ledger entry.
 *   2. Sets missing reservedQuantity values to 0.
 *
 * Safe to run again: already-corrected rows are skipped.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const businessId = arg('--business');

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
  console.log(APPLY ? 'Mode: APPLY' : 'Mode: DRY RUN (add --apply to write)');

  try {
    const db = mongoose.connection.db;

    if (!db) {
      throw new Error('MongoDB database connection is unavailable.');
    }

    // Load models after connecting.
    const BranchInventory = require('../src/models/BranchInventory');
    const WarehouseInventory = require('../src/models/WarehouseInventory');
    const Product = require('../src/models/Product');
    const { applyStockChange } = require('../src/services/inventory.service');

    if (businessId && !mongoose.Types.ObjectId.isValid(businessId)) {
      throw new Error(`Invalid business ID: ${businessId}`);
    }

    const businessFilter = {};

    if (businessId) {
      businessFilter.businessId = new mongoose.Types.ObjectId(businessId);
    }

    async function fixPool(Model, location) {
      const filter = {
        quantity: { $lt: 0 },
        ...businessFilter
      };

      const rows = await Model.find(filter).lean();

      console.log(`\n${location}: ${rows.length} row(s) below zero`);

      const productIds = rows.map((row) => row.productId);

      const products = await Product.find({
        _id: { $in: productIds }
      })
        .select('name')
        .lean();

      const names = new Map(
        products.map((product) => [
          String(product._id),
          product.name
        ])
      );

      let fixed = 0;

      for (const row of rows) {
        console.log(
          `  ${names.get(String(row.productId)) || row.productId}` +
          ` | branch ${row.branchId}` +
          ` | on hand ${row.quantity}`
        );

        if (!APPLY) continue;

        const session = await mongoose.startSession();

        try {
          await session.withTransaction(async () => {
            const fresh = await Model.findById(row._id).session(session);

            if (!fresh || fresh.quantity >= 0) {
              return;
            }

            await applyStockChange({
              businessId: fresh.businessId,
              branchId: fresh.branchId,
              productId: fresh.productId,
              variantId: fresh.variantId || null,
              quantityDelta: -fresh.quantity,
              type: 'ADJUSTMENT_IN',
              referenceType: 'ManualAdjustment',
              referenceId: null,
              reason: 'Negative stock corrected to 0',
              performedBy: undefined,
              session,
              location,
              warehouseId:
                location === 'WAREHOUSE'
                  ? fresh.warehouseId
                  : null
            });

            fixed += 1;
          });
        } finally {
          await session.endSession();
        }
      }

      if (APPLY) {
        console.log(`  Corrected: ${fixed}`);
      }
    }

    // Correct negative stock.
    await fixPool(BranchInventory, 'RETAIL');
    await fixPool(WarehouseInventory, 'WAREHOUSE');

    // Correct missing reservedQuantity values.
    for (const [Model, label] of [
      [BranchInventory, 'retail'],
      [WarehouseInventory, 'warehouse']
    ]) {
      const filter = {
        reservedQuantity: { $exists: false },
        ...businessFilter
      };

      const count = await Model.countDocuments(filter);

      console.log(
        `\n${label}: ${count} row(s) without reservedQuantity`
      );

      if (APPLY && count > 0) {
        const result = await Model.collection.updateMany(
          filter,
          {
            $set: { reservedQuantity: 0 }
          }
        );

        console.log(
          `  Set reservedQuantity=0 on ${result.modifiedCount} row(s).`
        );
      } else if (!APPLY && count > 0) {
        console.log('  Dry run only. Nothing was changed.');
      }
    }

    console.log('\nStock correction completed.');

  } finally {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  }
}

main().catch((error) => {
  console.error('Stock correction failed:', error);
  process.exitCode = 1;
});
