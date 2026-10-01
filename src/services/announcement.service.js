/**
 * announcement.service.js - platform announcements.
 *
 *  - PLATFORM side (SUPER_ADMIN): create / edit / pause / delete, list with live status.
 *  - TENANT side: listActive() returns what the calling user should see on ONE page,
 *    already filtered by role, schedule, pause switch and page placement.
 *
 * Nothing here is scoped by businessId: announcements are platform-wide.
 */
const Announcement = require('../models/Announcement');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function paging(q = {}) {
  return {
    page: Math.max(parseInt(q.page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(q.limit, 10) || 15, 1), 100),
  };
}

/* ------------------------------ status ------------------------------ */
function statusOf(a, now = new Date()) {
  if (!a.isActive) return 'PAUSED';
  if (new Date(a.startsAt) > now) return 'SCHEDULED';
  if (a.endsAt && new Date(a.endsAt) <= now) return 'EXPIRED';
  return 'LIVE';
}
const present = (a, now) => ({ ...a, status: statusOf(a, now) });

function statusFilter(status, now) {
  switch (status) {
    case 'PAUSED': return { isActive: false };
    case 'SCHEDULED': return { isActive: true, startsAt: { $gt: now } };
    case 'EXPIRED': return { isActive: true, startsAt: { $lte: now }, endsAt: { $lte: now } };
    case 'LIVE':
      return { isActive: true, startsAt: { $lte: now }, $or: [{ endsAt: null }, { endsAt: { $gt: now } }] };
    default: return {};
  }
}

function assertWindow(startsAt, endsAt, now) {
  if (!endsAt) return;
  if (endsAt <= startsAt) throw ApiError.badRequest('End time must be after the start time', 'INVALID_SCHEDULE');
  if (endsAt <= now) throw ApiError.badRequest('End time must be in the future', 'INVALID_SCHEDULE');
}

/** Audit must never break the main action. */
async function audit(admin, action, a, newValue) {
  try {
    await AuditLog.create({
      userId: admin._id,
      action,
      entityType: 'Announcement',
      entityId: a._id,
      newValue: newValue || { title: a.title },
    });
  } catch (err) {
    console.error('[announcements] audit log failed:', err.message);
  }
}

/* ====================================================================== */
/* PLATFORM ADMIN SIDE                                                    */
/* ====================================================================== */
async function adminList(q = {}) {
  const { page, limit } = paging(q);
  const now = new Date();
  const and = [];
  if (q.status) and.push(statusFilter(q.status, now));
  if (q.type) and.push({ type: q.type });
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    and.push({ $or: [{ title: re }, { message: re }] });
  }
  const filter = and.length ? { $and: and } : {};

  const [rows, total] = await Promise.all([
    Announcement.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Announcement.countDocuments(filter),
  ]);
  return { items: rows.map((r) => present(r, now)), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function adminGet(id) {
  const a = await Announcement.findById(id).lean();
  if (!a) throw ApiError.notFound('Announcement not found');
  return present(a, new Date());
}

async function adminCreate(admin, body) {
  const now = new Date();
  const startsAt = body.startNow ? now : body.startsAt || now;
  const endsAt = body.endsAt || undefined;
  assertWindow(startsAt, endsAt, now);

  const doc = await Announcement.create({
    title: body.title,
    message: body.message,
    type: body.type,
    roles: body.roles || [],
    placements: body.placements,
    frequency: body.frequency,
    startsAt,
    endsAt,
    isActive: body.isActive !== false,
    version: 1,
    createdBy: admin._id,
    createdByName: admin.name,
  });

  await audit(admin, 'admin.announcement.create', doc, {
    title: doc.title, roles: doc.roles, placements: doc.placements, startsAt, endsAt,
  });
  return present(doc.toObject(), now);
}

async function adminUpdate(admin, id, body) {
  const a = await Announcement.findById(id);
  if (!a) throw ApiError.notFound('Announcement not found');

  const now = new Date();
  const startsAt = body.startNow ? now : body.startsAt || a.startsAt;
  const endsAt = body.endsAt === undefined ? a.endsAt : body.endsAt; // null clears the end date
  assertWindow(startsAt, endsAt, now);

  const wordingChanged = a.title !== body.title || a.message !== body.message;

  a.title = body.title;
  a.message = body.message;
  a.type = body.type;
  a.roles = body.roles || [];
  a.placements = body.placements;
  a.frequency = body.frequency;
  a.startsAt = startsAt;
  a.endsAt = endsAt || undefined;
  if (body.isActive !== undefined) a.isActive = body.isActive;
  if (wordingChanged || body.resend) a.version += 1;
  a.updatedBy = admin._id;
  await a.save();

  await audit(admin, 'admin.announcement.update', a, {
    title: a.title, roles: a.roles, placements: a.placements, startsAt, endsAt: a.endsAt, version: a.version,
  });
  return present(a.toObject(), now);
}

async function adminSetActive(admin, id, isActive) {
  const a = await Announcement.findById(id);
  if (!a) throw ApiError.notFound('Announcement not found');
  a.isActive = isActive;
  a.updatedBy = admin._id;
  await a.save();
  await audit(admin, isActive ? 'admin.announcement.resume' : 'admin.announcement.pause', a, { isActive });
  return present(a.toObject(), new Date());
}

async function adminRemove(admin, id) {
  const a = await Announcement.findByIdAndDelete(id);
  if (!a) throw ApiError.notFound('Announcement not found');
  await audit(admin, 'admin.announcement.delete', a);
  return { _id: a._id };
}

/* ====================================================================== */
/* TENANT SIDE                                                            */
/* ====================================================================== */
async function listActive(user, page) {
  const now = new Date();
  const rows = await Announcement.find({
    isActive: true,
    startsAt: { $lte: now },
    'placements.page': page,
    $and: [
      { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] },
      { $or: [{ roles: { $size: 0 } }, { roles: { $exists: false } }, { roles: user.role }] },
    ],
  })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();

  const items = rows.map((a) => {
    const placement = a.placements.find((p) => p.page === page);
    return {
      _id: a._id,
      title: a.title,
      message: a.message,
      type: a.type,
      display: placement.display,
      frequency: a.frequency,
      version: a.version,
      startsAt: a.startsAt,
      endsAt: a.endsAt || null,
    };
  });
  return { items, serverTime: now.toISOString() };
}

module.exports = {
  adminList, adminGet, adminCreate, adminUpdate, adminSetActive, adminRemove, listActive,
};