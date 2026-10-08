const mongoose = require('mongoose');

/** Runs fn(session) inside a Mongo transaction (needs a replica set - the sales module already depends on one). */
module.exports = async function withTx(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    session.endSession();
  }
};