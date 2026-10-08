const PlatformSettings = require('../models/PlatformSettings');

let cache = null;
let cacheAt = 0;

async function ensure() {
  try {
    return await PlatformSettings.findOneAndUpdate(
      { key: 'billing' }, { $setOnInsert: { key: 'billing' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code === 11000) return PlatformSettings.findOne({ key: 'billing' });
    throw err;
  }
}

/** Lean settings WITHOUT secrets (credentialsBlob is select:false). Cached for 15s. */
async function get({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 15000) return cache;
  await ensure();
  cache = await PlatformSettings.findOne({ key: 'billing' }).lean();
  cacheAt = Date.now();
  return cache;
}

/** Mongoose document INCLUDING the encrypted STK credentials - only for code that talks to PayHero or edits settings. */
async function getWithSecrets() {
  await ensure();
  return PlatformSettings.findOne({ key: 'billing' }).select('+stk.credentialsBlob');
}

const invalidate = () => { cache = null; };

module.exports = { get, getWithSecrets, invalidate };