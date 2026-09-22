const Notification = require('../models/Notification');
const User = require('../models/User');
const { ROLES } = require('../constants/roles');

/** Creates one notification for a specific user. */
async function notifyUser(businessId, userId, { type, title, message, data }) {
  return Notification.create({ businessId, userId, type, title, message, data });
}

/**
 * notifyManagement - the common case: something needs an owner/admin/manager's
 * attention (low stock, a failed eTIMS submission, a cash shortage). Fans the
 * same notification out to every active OWNER/ADMIN/MANAGER on the business.
 */
async function notifyManagement(businessId, { type, title, message, data }) {
  const recipients = await User.find({
    businessId,
    status: 'active',
    role: { $in: [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER] },
  }).select('_id');

  if (!recipients.length) return [];
  return Notification.insertMany(
    recipients.map((u) => ({ businessId, userId: u._id, type, title, message, data }))
  );
}

async function listForUser(businessId, userId, { unreadOnly, page, limit }) {
  const filter = { businessId, userId };
  if (unreadOnly) filter.readAt = null;

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ businessId, userId, readAt: null }),
  ]);

  return { items, total, page, limit, pages: Math.ceil(total / limit), unreadCount };
}

async function markRead(businessId, userId, id) {
  return Notification.findOneAndUpdate(
    { _id: id, businessId, userId },
    { readAt: new Date() },
    { new: true }
  );
}

async function markAllRead(businessId, userId) {
  const result = await Notification.updateMany(
    { businessId, userId, readAt: null },
    { readAt: new Date() }
  );
  return { updated: result.modifiedCount };
}

module.exports = { notifyUser, notifyManagement, listForUser, markRead, markAllRead };