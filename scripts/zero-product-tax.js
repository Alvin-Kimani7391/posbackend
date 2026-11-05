/**
 * zero-product-tax.js
 *
 * Run from the POS backend root:
 *   node scripts/zero-product-tax.js                 (dry run, writes nothing)
 *   node scripts/zero-product-tax.js --apply         (writes changes)
 *
 * Options:
 *   --rate 16          tax rate to reset to 0 (default 16)
 *   --business <id>    limit to one business
 *
 * Database:
 *   Defaults to "test" (same as migrate-multi-warehouse.js).
 *   Override using MIGRATION_DB_NAME.
 *
 * Operation:
 *   Products created with the old default 16% tax rate are set to 0%,
 *   because VAT is already inside the cost price and must not be charged
 *   on the selling price. Past sales are not modified.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const rate = Number(arg('--rate') ?? 16);
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
  console.log(apply ? 'Mode: APPLY' : 'Mode: DRY RUN (add --apply to write)');

  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('MongoDB database connection is unavailable.');

    const products = db.collection('products');

    const total = await products.countDocuments({});
    console.log(`Total products in database: ${total}`);

    // Show which tax rates exist so you can confirm the right one is targeted.
    const breakdown = await products
      .aggregate([
        { $group: { _id: '$taxRate', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
      .toArray();
    console.log('Tax rate breakdown:');
    for (const row of breakdown) {
      console.log(`   taxRate=${row._id === null ? 'null/missing' : row._id}%  ->  ${row.count} product(s)`);
    }

    const filter = { taxRate: rate };
    if (businessId) filter.businessId = new mongoose.Types.ObjectId(businessId);

    const count = await products.countDocuments(filter);
    console.log(`Products with taxRate=${rate}%: ${count}`);

    if (apply && count > 0) {
      const result = await products.updateMany(filter, {
        $set: { taxRate: 0 }
      });
      console.log(`Updated ${result.modifiedCount} product(s) to taxRate=0.`);
    } else if (!apply && count > 0) {
      console.log('Dry run only. Nothing was changed.');
    }
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB connection closed.');
  }
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});