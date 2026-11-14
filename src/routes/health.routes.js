const router = require('express').Router();
const mongoose = require('mongoose');
const { mongoUri } = require('../config/env');
const { describeUri } = require('../config/dbInfo');

const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
const meta = () => ({
  release: process.env.RELEASE_ID || 'unknown',
  commit: process.env.GIT_SHA || 'unknown',
  slot: process.env.APP_SLOT || 'unknown',
  jobs: process.env.RUN_JOBS === 'false' ? 'off' : 'on',
});

// Liveness (unchanged behaviour + release info)
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    database: states[mongoose.connection.readyState] || 'unknown',
    timestamp: new Date().toISOString(),
    ...meta(),
  });
});

// Readiness: 503 unless the DB is connected and answering. Used by deploy checks.
router.get('/ready', async (req, res) => {
  try {
    if (req.app.get('shuttingDown')) throw new Error('shutting down');
    if (mongoose.connection.readyState !== 1) throw new Error('db not connected');
    await mongoose.connection.db.admin().ping();
    res.status(200).json({ status: 'ready', ...meta() });
  } catch (e) {
    res.status(503).json({ status: 'not_ready', error: e.message, ...meta() });
  }
});

// Database readiness reported separately from process liveness: round-trip latency + whether this process talks to the LOCAL
// MongoDB Community instance (used by the migration cutover to prove the switch). Never returns credentials, hosts or error details.
router.get('/db', async (req, res) => {
  const local = describeUri(mongoUri).local;
  const t0 = Date.now();
  try {
    if (mongoose.connection.readyState !== 1) throw new Error('not connected');
    await mongoose.connection.db.admin().ping();
    res.status(200).json({ status: 'ok', database: { ready: true, latencyMs: Date.now() - t0, local }, ...meta() });
  } catch (e) {
    res.status(503).json({ status: 'db_unavailable', database: { ready: false, local }, ...meta() });
  }
});

module.exports = router;
