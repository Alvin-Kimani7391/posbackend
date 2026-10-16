
/**
 * migrate-wholesale-reports.js
 *
 * Run from the POS backend root:
 *
 *   node scripts/migrate-wholesale-reports.js
 *   node scripts/migrate-wholesale-reports.js --backfill-history
 *
 * Database:
 *   Defaults to "test".
 *   Override using MIGRATION_DB_NAME.
 *
 * What it does:
 *
 * 1. Enables multiWarehouse, unitConversions, and wholesalePricing
 *    for businesses whose businessType is "wholesale".
 *
 * 2. With --backfill-history, fills missing wholesaleValueSnapshot
 *    values on eligible historical sale lines.
 *
 * IMPORTANT:
 * - The historical backfill uses the product's CURRENT wholesale
 *   price, so historical profit comparisons are approximate.
 * - Only lines with no existing wholesaleValueSnapshot and no
 *   variantId are updated.
 * - Stock quantities are not changed.
 * - Safe to rerun; existing snapshots are preserved.
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
    const db = mongoose.connection.db;

    if (!db) {
      throw new Error('MongoDB database connection is unavailable.');
    }

    const businesses = db.collection('businesses');

    // ---------------------------------------------------------
    // 1. Enable wholesale features for wholesale businesses.
    // ---------------------------------------------------------
    const featureResult = await businesses.updateMany(
      { businessType: 'wholesale' },
      {
        $set: {
          'featureSettings.multiWarehouse': true,
          'featureSettings.unitConversions': true,
          'featureSettings.wholesalePricing': true
        }
      }
    );

    console.log(
      `1. Wholesale businesses matched: ${featureResult.matchedCount || 0}`
    );
    console.log(
      `1. Wholesale businesses updated: ${featureResult.modifiedCount || 0}`
    );

    // ---------------------------------------------------------
    // 2. Optionally backfill historical sale-line snapshots.
    // ---------------------------------------------------------
    if (process.argv.includes('--backfill-history')) {
      const { wholesaleFloorPerBase } = require('../src/utils/units');

      const productsCollection = db.collection('products');
      const salesCollection = db.collection('sales');

      const products = await productsCollection
        .find({
          $or: [
            { wholesalePrice: { $gt: 0 } },
            { 'units.wholesalePrice': { $gt: 0 } }
          ]
        })
        .toArray();

      let salesDocumentsModified = 0;
      let productsProcessed = 0;
      let productsSkipped = 0;

      console.log(
        `2. Found ${products.length} product(s) with a wholesale price.`
      );

      for (const product of products) {
        const floor = wholesaleFloorPerBase(product, null);

        if (
          floor == null ||
          !Number.isFinite(Number(floor)) ||
          Number(floor) <= 0
        ) {
          productsSkipped++;
          continue;
        }

        // Limit the update to sales containing this product.
        // The pipeline updates only eligible lines, preserving
        // all other line fields and existing snapshots.
        const result = await salesCollection.updateMany(
          {
            businessId: product.businessId,
            items: {
              $elemMatch: {
                productId: product._id,
                wholesaleValueSnapshot: { $exists: false },
                variantId: { $exists: false }
              }
            }
          },
          [
            {
              $set: {
                items: {
                  $map: {
                    input: { $ifNull: ['$items', []] },
                    as: 'item',
                    in: {
                      $cond: [
                        {
                          $and: [
                            { $eq: ['$$item.productId', product._id] },
                            {
                              $eq: [
                                { $type: '$$item.wholesaleValueSnapshot' },
                                'missing'
                              ]
                            },
                            {
                              $eq: [
                                { $type: '$$item.variantId' },
                                'missing'
                              ]
                            }
                          ]
                        },
                        {
                          $mergeObjects: [
                            '$$item',
                            {
                              wholesaleValueSnapshot: {
                                $round: [
                                  {
                                    $multiply: [
                                      Number(floor),
                                      {
                                        $ifNull: [
                                          '$$item.unitFactor',
                                          1
                                        ]
                                      }
                                    ]
                                  },
                                  0
                                ]
                              }
                            }
                          ]
                        },
                        '$$item'
                      ]
                    }
                  }
                }
              }
            }
          ]
        );

        salesDocumentsModified += result.modifiedCount || 0;
        productsProcessed++;
      }

      console.log(`2. Products processed: ${productsProcessed}`);
      console.log(`2. Products skipped: ${productsSkipped}`);
      console.log(
        `2. Sale documents modified: ${salesDocumentsModified}`
      );
      console.log(
        '2. Backfill finished. Existing wholesale snapshots were preserved.'
      );
    } else {
      console.log(
        '2. Historical backfill skipped. Use --backfill-history to enable it.'
      );
    }

    console.log('Migration completed successfully.');
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
