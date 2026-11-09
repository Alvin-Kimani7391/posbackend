const router = require('express').Router();
const mongoose = require('mongoose');

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

module.exports = router;