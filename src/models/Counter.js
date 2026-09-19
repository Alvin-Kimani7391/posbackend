const { Schema, model } = require('mongoose');

// One document per (businessId, sequenceKey). $inc is atomic in MongoDB, so
// two simultaneous sales on the same branch can never receive the same number.
const counterSchema = new Schema({
  businessId: { type: Schema.Types.ObjectId, required: true },
  key: { type: String, required: true }, // e.g. "receipt:branch:<branchId>", "purchase:business"
  seq: { type: Number, default: 0 },
});

counterSchema.index({ businessId: 1, key: 1 }, { unique: true });

const Counter = model('Counter', counterSchema);

/**
 * nextSequence(businessId, key, session) -> integer, atomically incremented.
 * Pass the active mongoose session so this participates in the caller's transaction.
 */
async function nextSequence(businessId, key, session) {
  const doc = await Counter.findOneAndUpdate(
    { businessId, key },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session }
  );
  return doc.seq;
}

/** Formats a running number with zero-padding, e.g. pad(42, 6) -> "000042". */
function pad(n, width = 6) {
  return String(n).padStart(width, '0');
}

module.exports = { Counter, nextSequence, pad };