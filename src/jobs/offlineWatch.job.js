const cron = require('node-cron');
const Device = require('../models/Device');
const notificationService = require('../services/notification.service');

const STALE_MS = 6 * 60 * 60 * 1000;     // quiet for 6 h while holding unsynced sales
const REALERT_MS = 24 * 60 * 60 * 1000;  // do not nag more than once a day per till

/** Tells management about tills that hold unsynced sales but have gone quiet (offline too long, stolen, broken). */
async function run() {
  const now = Date.now();
  const notAlertedRecently = [{ lastStaleAlertAt: null }, { lastStaleAlertAt: { $lt: new Date(now - REALERT_MS) } }];
  const stale = await Device.find({
    status: 'active', offlineEnabled: true, lastPendingCount: { $gt: 0 },
    lastSeenAt: { $lt: new Date(now - STALE_MS) }, $or: notAlertedRecently,
  }).limit(100);

  for (const d of stale) {
    const taken = await Device.updateOne({ _id: d._id, $or: notAlertedRecently }, { $set: { lastStaleAlertAt: new Date() } });
    if (!taken.modifiedCount) continue;
    try {
      await notificationService.notifyManagement(d.businessId, {
        type: 'SYSTEM_ALERT',
        title: `Till ${d.deviceCode || d.deviceName || ''} has unsynced sales`,
        message: `${d.deviceName || 'A till'} (${d.deviceCode || 'no code'}) holds ${d.lastPendingCount} unsynced sale(s) and has not contacted the server since ${d.lastSeenAt ? d.lastSeenAt.toISOString() : 'ever'}. Check that it is online. If it was lost or stolen, block it under Devices.`,
        branchId: d.branchId, entityType: 'Device', entityId: d._id, data: { deviceId: d.deviceId, pending: d.lastPendingCount },
      });
    } catch (err) {
      console.error('[offline watch] notify failed', err.message);
    }
  }
}

function start() {
  cron.schedule('*/30 * * * *', () => run().catch((err) => console.error('[offline watch job]', err)));
}

module.exports = { start, run };