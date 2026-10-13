/**
 * migrate-feature-settings.js
 *
 * Backfills Business.featureSettings from businessType
 * in the MongoDB "test" database.
 *
 * Usage:
 *   node scripts/migrate-feature-settings.js
 *   node scripts/migrate-feature-settings.js --apply
 *
 * Dry run is the default.
 *
 * SAFETY:
 * - Only enables features that resolve to true.
 * - Never disables existing features.
 * - Preserves existing custom feature flags.
 * - Updates only featureSettings.
 * - Uses the "test" database explicitly.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const Business = require('../src/models/Business');

const {
  resolveFeatures,
} = require('../src/constants/businessFeatures');

async function main() {
  const apply = process.argv.includes('--apply');

  const uri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.DATABASE_URL;

  if (!uri) {
    throw new Error(
      'MongoDB URI is missing. Check your .env file.'
    );
  }

  console.log('\n========================================');
  console.log('BUSINESS FEATURE SETTINGS MIGRATION');
  console.log('========================================');

  console.log('Mode:', apply ? 'APPLY' : 'DRY RUN');
  console.log('Connecting to MongoDB...');

  await mongoose.connect(uri);

  try {
    // Explicitly target the test database, as in the working
    // migrate-pos-indexes.js script.
    const testDb = mongoose.connection.useDb('test');

    // Use the Business model's schema against the test connection.
    const TestBusiness =
      testDb.models.Business ||
      testDb.model('Business', Business.schema, 'businesses');

    console.log('\nConnected to MongoDB.');
    console.log('Database:', testDb.name);
    console.log('Collection:', TestBusiness.collection.name);
    console.log('Mode:', apply ? 'APPLY' : 'DRY RUN');

    const total = await TestBusiness.countDocuments({});

    console.log('Businesses found:', total);

    if (total === 0) {
      console.log(
        '\nNo businesses found in test.businesses.'
      );
      console.log(
        'Confirm the collection name before applying changes.'
      );
      return;
    }

    let processed = 0;
    let changed = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let flagsEnabled = 0;

    const enabledCounts = {};

    console.log('\nProcessing businesses...\n');

    const cursor = TestBusiness.find({})
      .select('_id businessType featureSettings')
      .lean()
      .cursor();

    for await (const business of cursor) {
      processed++;

      try {
        const businessType =
          business.businessType || 'general_shop';

        const current =
          business.featureSettings &&
          typeof business.featureSettings === 'object' &&
          !Array.isArray(business.featureSettings)
            ? business.featureSettings
            : {};

        const defaults = resolveFeatures(
          businessType,
          current
        );

        if (
          !defaults ||
          typeof defaults !== 'object' ||
          Array.isArray(defaults)
        ) {
          throw new Error(
            'resolveFeatures() returned an invalid result.'
          );
        }

        // Preserve existing settings and enable missing defaults only.
        const next = { ...current };
        const newlyEnabled = [];

        for (const [key, value] of Object.entries(defaults)) {
          if (value === true && current[key] !== true) {
            next[key] = true;
            newlyEnabled.push(key);
          }
        }

        if (newlyEnabled.length === 0) {
          unchanged++;
          continue;
        }

        changed++;

        console.log(
          `[${apply ? 'APPLY' : 'DRY RUN'}] ` +
          `${business._id} | ` +
          `type=${businessType} | ` +
          `enable=${newlyEnabled.join(', ')}`
        );

        if (apply) {
          // Update only the featureSettings field.
          // Avoid overwriting concurrent changes to the settings.
          const result = await TestBusiness.updateOne(
            {
              _id: business._id,
              featureSettings: business.featureSettings,
            },
            {
              $set: {
                featureSettings: next,
              },
            }
          );

          if (result.matchedCount === 0) {
            failed++;

            console.warn(
              `SKIPPED ${business._id}: the record or its settings ` +
              'changed during migration. Rerun the script.'
            );

            continue;
          }

          updated++;
        }

        flagsEnabled += newlyEnabled.length;

        for (const key of newlyEnabled) {
          enabledCounts[key] =
            (enabledCounts[key] || 0) + 1;
        }
      } catch (error) {
        failed++;

        console.error(
          `ERROR processing business ${business._id}:`,
          error.message
        );
      }
    }

    console.log('\n========================================');
    console.log('MIGRATION SUMMARY');
    console.log('========================================');

    console.log('Database:', testDb.name);
    console.log('Collection:', TestBusiness.collection.name);
    console.log('Mode:', apply ? 'APPLY' : 'DRY RUN');
    console.log('Total businesses:', total);
    console.log('Businesses processed:', processed);
    console.log('Businesses requiring changes:', changed);
    console.log('Businesses unchanged:', unchanged);

    if (apply) {
      console.log('Businesses updated:', updated);
    }

    console.log('Errors or skipped updates:', failed);
    console.log('Feature flags enabled:', flagsEnabled);

    console.log('\nFeature breakdown:');

    const entries = Object.entries(enabledCounts);

    if (entries.length === 0) {
      console.log('No feature flags need enabling.');
    } else {
      for (const [key, count] of entries) {
        console.log(`  ${key}: ${count} business(es)`);
      }
    }

    if (!apply) {
      console.log('\nDRY RUN COMPLETED.');
      console.log('No business records were modified.');
      console.log(
        'Review the proposed changes before running with --apply.'
      );
    } else {
      console.log('\nMIGRATION COMPLETED.');
      console.log(`Successfully updated ${updated} businesses.`);
    }

    if (failed > 0) {
      console.error(
        `WARNING: ${failed} business(es) failed or were skipped.`
      );

      process.exitCode = 1;
    }
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB.');
  }
}

main().catch((error) => {
  console.error('\nMIGRATION FAILED:');
  console.error(error);
  process.exitCode = 1;
});