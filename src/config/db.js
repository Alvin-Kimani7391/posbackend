const mongoose = require('mongoose');
const logger = require('../utils/logger');
const { mongoUri } = require('./env');
const { describeUri } = require('./dbInfo');

mongoose.set('strictQuery', true);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Works unchanged against MongoDB Atlas (mongodb+srv://) and the local MongoDB Community replica set
// (mongodb://127.0.0.1:27017/db?replicaSet=rs0&authSource=db). Only the MONGODB_URI environment variable decides which one is used.
// After a reboot PM2 can start before mongod is ready, so a few spaced retries are made before giving up (PM2 then restarts the process as before).
async function connectDB() {
  const attempts = Math.max(1, parseInt(process.env.MONGO_CONNECT_RETRIES, 10) || 3);
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await mongoose.connect(mongoUri, {
        maxPoolSize: parseInt(process.env.MONGO_MAX_POOL, 10) || 20,
        serverSelectionTimeoutMS: parseInt(process.env.MONGO_SERVER_SELECTION_MS, 10) || 15000,
      });
      logger.info('MongoDB connected', { hosting: describeUri(mongoUri).kind });
      return;
    } catch (err) {
      logger.error('MongoDB connection failed', { error: String(err.message).replace(/mongodb(\+srv)?:\/\/[^@\s]*@/gi, 'mongodb://***@'), attempt: i, of: attempts });
      if (i === attempts) process.exit(1);
      await sleep(3000 * i);
    }
  }
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error('MongoDB error', { error: err.message });
});

async function disconnectDB() {
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB, mongoose };
