/**
 * ticket.service.js - support tickets.
 *
 * Two audiences:
 *  - TENANT side (shop owner / manager / cashier / storekeeper): raise a ticket,
 *    follow the conversation, add screenshots, confirm-close.
 *    Visibility: OWNER/ADMIN/MANAGER see every ticket in their business;
 *    everyone else sees only the tickets they raised.
 *  - PLATFORM side (SUPER_ADMIN): sees tickets from EVERY business (never
 *    scoped by businessId), replies, changes status, writes the resolution.
 *
 * Notifications go to the people on the shop side (the existing bell).
 * Super admin is notified through the admin "awaiting you" badge/inbox
 * instead, because Notification documents are tenant-scoped (businessId).
 */
const Ticket = require('../models/Ticket');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');
const notificationService = require('./notification.service');

const SEE_ALL_ROLES = [ROLES.OWNER, ROLES.ADMIN, ROLES.MANAGER];
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idOf = (v) => (v && v._id) || v;

function paging(q = {}) {
  return {
    page: Math.max(parseInt(q.page, 10) || 1, 1),
    limit: Math.min(Math.max(parseInt(q.limit, 10) || 15, 1), 100),
  };
}

const toAttachments = (files = []) =>
  files.map((f) => ({ url: f.path, publicId: f.filename, originalName: f.originalname, size: f.size, format: f.format }));

/** Sequential, human-friendly number (TKT-00042). Retries if two tickets race for the same number. */
async function createWithNumber(data) {
  for (let i = 0; i < 5; i += 1) {
    const count = await Ticket.countDocuments({});
    try {
      return await Ticket.create({ ...data, ticketNumber: `TKT-${String(count + 1 + i).padStart(5, '0')}` });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
  throw ApiError.badRequest('Could not generate a ticket number, please try again', 'TICKET_NUMBER_FAILED');
}

/** Notifications must never break the main action. */
async function safely(fn) {
  try { await fn(); } catch (err) { console.error('[tickets] notification failed:', err.message); }
}

function notifyRaiser(ticket, { type, title, message }) {
  return safely(() => notificationService.notifyUser(idOf(ticket.businessId), ticket.raisedBy, {
    type, title, message,
    branchId: ticket.branchId,
    entityType: 'Ticket',
    entityId: ticket._id,
    data: { ticketNumber: ticket.ticketNumber, status: ticket.status },
  }));
}

/* ====================================================================== */
/* TENANT SIDE                                                            */
/* ====================================================================== */

async function createTicket(businessId, user, body, files) {
  const ticket = await createWithNumber({
    businessId,
    branchId: body.branchId || user.branchIds?.[0],
    raisedBy: user._id,
    raisedByName: user.name,
    raisedByRole: user.role,
    subject: body.subject,
    description: body.description,
    category: body.category,
    priority: body.priority,
    errorMessage: body.errorMessage || undefined,
    pageUrl: body.pageUrl || undefined,
    userAgent: body.userAgent,
    attachments: toAttachments(files),
    awaitingAdmin: true,
  });

  await safely(() => {
    const base = {
      type: 'TICKET_CREATED', branchId: ticket.branchId, sourceUserId: user._id,
      entityType: 'Ticket', entityId: ticket._id, data: { ticketNumber: ticket.ticketNumber, status: 'OPEN' },
    };
    return notificationService.notifyActorAndManagement(
      businessId, user,
      { ...base, title: `Support ticket ${ticket.ticketNumber} raised`, message: `${user.name} raised a support ticket: "${ticket.subject}".` },
      { ...base, title: `Ticket ${ticket.ticketNumber} received`, message: `We received "${ticket.subject}". You'll be notified here when support replies.` }
    );
  });

  return ticket;
}

function visibleFilter(businessId, user) {
  const filter = { businessId };
  if (!SEE_ALL_ROLES.includes(user.role)) filter.raisedBy = user._id;
  return filter;
}

async function listTickets(businessId, user, q) {
  const { page, limit } = paging(q);
  const filter = visibleFilter(businessId, user);
  if (q.status) filter.status = q.status;
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    filter.$or = [{ ticketNumber: re }, { subject: re }];
  }
  const [items, total] = await Promise.all([
    Ticket.find(filter).select('-replies -userAgent').sort({ lastActivityAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Ticket.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function getTicket(businessId, user, id) {
  const ticket = await Ticket.findOne({ ...visibleFilter(businessId, user), _id: id }).lean();
  if (!ticket) throw ApiError.notFound('Ticket not found');
  return ticket;
}

async function addReply(businessId, user, id, message, files) {
  const ticket = await Ticket.findOne({ ...visibleFilter(businessId, user), _id: id });
  if (!ticket) throw ApiError.notFound('Ticket not found');
  if (ticket.status === 'CLOSED') {
    throw ApiError.badRequest('This ticket is closed. Please raise a new ticket.', 'TICKET_CLOSED');
  }

  ticket.replies.push({
    authorId: user._id, authorName: user.name, authorRole: user.role,
    isStaff: false, message, attachments: toAttachments(files),
  });
  if (ticket.status === 'RESOLVED') { // replying to a resolved ticket = "still broken" -> reopen
    ticket.status = 'OPEN';
    ticket.resolvedAt = undefined;
  }
  ticket.awaitingAdmin = true;
  ticket.lastActivityAt = new Date();
  await ticket.save();
  return ticket;
}

/** Shop side confirms the problem is fixed. */
async function closeOwn(businessId, user, id) {
  const ticket = await Ticket.findOne({ ...visibleFilter(businessId, user), _id: id });
  if (!ticket) throw ApiError.notFound('Ticket not found');
  if (ticket.status === 'CLOSED') return ticket;
  ticket.status = 'CLOSED';
  ticket.closedAt = new Date();
  ticket.awaitingAdmin = false;
  ticket.lastActivityAt = new Date();
  await ticket.save();
  return ticket;
}

/* ====================================================================== */
/* PLATFORM ADMIN SIDE                                                    */
/* ====================================================================== */

const flattenAdmin = (t) => ({
  ...t,
  businessName: t.businessId?.name,
  businessPhone: t.businessId?.phone,
  businessId: idOf(t.businessId),
  raisedByPhone: t.raisedBy?.phone,
  raisedBy: idOf(t.raisedBy),
});

async function adminList(q) {
  const { page, limit } = paging(q);
  const filter = {};
  if (q.status) filter.status = q.status;
  if (q.priority) filter.priority = q.priority;
  if (q.businessId) filter.businessId = q.businessId;
  if (q.awaiting === 'true') filter.awaitingAdmin = true;
  if (q.from || q.to) {
    filter.createdAt = {};
    if (q.from) filter.createdAt.$gte = new Date(q.from);
    if (q.to) filter.createdAt.$lte = new Date(q.to);
  }
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    filter.$or = [{ ticketNumber: re }, { subject: re }, { raisedByName: re }];
  }

  const [items, total] = await Promise.all([
    Ticket.find(filter).select('-replies')
      .populate('businessId', 'name phone')
      .sort({ awaitingAdmin: -1, lastActivityAt: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Ticket.countDocuments(filter),
  ]);
  return { items: items.map(flattenAdmin), total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

async function adminStats() {
  const rows = await Ticket.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const awaitingAdmin = await Ticket.countDocuments({ awaitingAdmin: true, status: { $in: ['OPEN', 'IN_PROGRESS'] } });
  return {
    awaitingAdmin,
    open: by.OPEN || 0,
    inProgress: by.IN_PROGRESS || 0,
    resolved: by.RESOLVED || 0,
    closed: by.CLOSED || 0,
  };
}

async function adminGet(id) {
  const ticket = await Ticket.findById(id)
    .populate('businessId', 'name phone email')
    .populate('raisedBy', 'name phone role')
    .lean();
  if (!ticket) throw ApiError.notFound('Ticket not found');
  return flattenAdmin(ticket);
}

async function adminReply(admin, id, message, files) {
  const ticket = await Ticket.findById(id);
  if (!ticket) throw ApiError.notFound('Ticket not found');
  if (ticket.status === 'CLOSED') throw ApiError.badRequest('Ticket is closed - reopen it first', 'TICKET_CLOSED');

  ticket.replies.push({
    authorId: admin._id, authorName: admin.name, authorRole: 'SUPPORT',
    isStaff: true, message, attachments: toAttachments(files),
  });
  if (ticket.status === 'OPEN') ticket.status = 'IN_PROGRESS';
  if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
  ticket.awaitingAdmin = false;
  ticket.lastActivityAt = new Date();
  await ticket.save();

  await notifyRaiser(ticket, {
    type: 'TICKET_REPLY',
    title: `Support replied - ${ticket.ticketNumber}`,
    message: message.length > 160 ? `${message.slice(0, 157)}...` : message,
  });
  return ticket;
}

async function adminUpdate(admin, id, { status, priority, resolution }) {
  const ticket = await Ticket.findById(id);
  if (!ticket) throw ApiError.notFound('Ticket not found');

  const before = { status: ticket.status, priority: ticket.priority };
  if (priority) ticket.priority = priority;
  if (resolution !== undefined && resolution !== '') ticket.resolution = resolution;

  let notice = null;
  if (status && status !== ticket.status) {
    const finishing = status === 'RESOLVED' || status === 'CLOSED';
    if (finishing && !ticket.resolution) {
      throw ApiError.badRequest('Add a resolution note explaining the fix before resolving or closing', 'RESOLUTION_REQUIRED');
    }
    ticket.status = status;
    ticket.awaitingAdmin = false;
    if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();

    if (status === 'RESOLVED') {
      ticket.resolvedAt = new Date(); ticket.resolvedBy = admin._id; ticket.closedAt = undefined;
      notice = { type: 'TICKET_RESOLVED', title: `Ticket resolved - ${ticket.ticketNumber}`, message: `Fixed: ${ticket.resolution}. Reply on the ticket if it's still not working.` };
    } else if (status === 'CLOSED') {
      ticket.closedAt = new Date();
      if (!ticket.resolvedAt) { ticket.resolvedAt = new Date(); ticket.resolvedBy = admin._id; }
      notice = { type: 'TICKET_CLOSED', title: `Ticket closed - ${ticket.ticketNumber}`, message: `Your ticket "${ticket.subject}" has been solved and closed. ${ticket.resolution}` };
    } else {
      ticket.resolvedAt = undefined; ticket.closedAt = undefined;
      notice = { type: 'TICKET_UPDATED', title: `Ticket updated - ${ticket.ticketNumber}`, message: `Status changed to ${status.replace('_', ' ').toLowerCase()}.` };
      if (status === 'OPEN') ticket.awaitingAdmin = true;
    }
  }

  ticket.lastActivityAt = new Date();
  await ticket.save();

  await safely(() => AuditLog.create({
    businessId: ticket.businessId, userId: admin._id,
    action: 'admin.ticket.update', entityType: 'Ticket', entityId: ticket._id,
    oldValue: before, newValue: { status: ticket.status, priority: ticket.priority },
  }));
  if (notice) await notifyRaiser(ticket, notice);
  return ticket;
}

module.exports = {
  createTicket, listTickets, getTicket, addReply, closeOwn,
  adminList, adminStats, adminGet, adminReply, adminUpdate,
};
