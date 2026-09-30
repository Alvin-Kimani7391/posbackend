/**
 * admin.service.js - PLATFORM-WIDE queries for the SUPER_ADMIN panel.
 *
 * Unlike every other service, nothing here is scoped to req.businessId: the
 * caller is authenticated as SUPER_ADMIN (see requireSuperAdmin) and may look
 * at every business. Never reuse these functions from a tenant route.
 *
 * Money: documents store integer CENTS. Aggregations bypass the
 * moneySchemaPlugin conversion, so every money value is divided by 100 here
 * explicitly - the admin frontend receives shillings, like the reports API.
 */
const mongoose = require('mongoose');
const Business = require('../models/Business');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const ProductVariant = require('../models/ProductVariant');
const Category = require('../models/Category');
const Customer = require('../models/Customer');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');
const { ROLES } = require('../constants/roles');

const TZ = 'Africa/Nairobi';
const EAT_OFFSET_MS = 3 * 3600 * 1000; // Kenya has no DST

/* ------------------------------ helpers ------------------------------ */
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const cents = (expr) => ({ $divide: [expr, 100] });
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const coll = (Model) => Model.collection.name;

function paging(q) {
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 15, 1), 100);
  return { page, limit };
}

function dateRange(from, to) {
  if (!from && !to) return null;
  const r = {};
  if (from) r.$gte = new Date(from);
  if (to) r.$lte = new Date(to);
  return r;
}

function startOfTodayEAT() {
  const t = Date.now() + EAT_OFFSET_MS;
  return new Date(t - (t % 86400000) - EAT_OFFSET_MS);
}

const lookupOne = (Model, localField, as) => [
  { $lookup: { from: coll(Model), localField, foreignField: '_id', as } },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
];

/** Counts docs of Model whose businessId == the outer doc's _id (for the businesses list). */
const countLookup = (Model, as, extra = {}) => ({
  $lookup: {
    from: coll(Model),
    let: { bid: '$_id' },
    pipeline: [{ $match: { ...extra, $expr: { $eq: ['$businessId', '$$bid'] } } }, { $count: 'n' }],
    as,
  },
});

const ownerLookup = (as = 'ow') => ({
  $lookup: {
    from: coll(User),
    let: { bid: '$_id' },
    pipeline: [
      { $match: { role: ROLES.OWNER, $expr: { $eq: ['$businessId', '$$bid'] } } },
      { $limit: 1 },
      { $project: { name: 1 } },
    ],
    as,
  },
});

/** match -> count + one page (sorted, then enriched ONLY for the page rows). */
async function paged(Model, match, sort, { page, limit }, enrich = []) {
  const [res] = await Model.aggregate([
    { $match: match },
    {
      $facet: {
        items: [{ $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }, ...enrich],
        total: [{ $count: 'n' }],
      },
    },
  ]);
  const total = res.total[0]?.n || 0;
  return { items: res.items, total, page, limit, pages: Math.ceil(total / limit) || 1 };
}

/* ------------------------------ overview ------------------------------ */
async function getOverview({ from, to } = {}) {
  const range = dateRange(from, to);
  const createdIn = range ? { createdAt: range } : {};
  const saleMatch = { saleStatus: 'COMPLETED', ...createdIn };
  const Refund = mongoose.models.Refund; // registered by the refunds module; skipped if absent

  const [sum, pay, refunds, trend, top, byStatus, employees, branches, products, newBusinesses, recent] = await Promise.all([
    Sale.aggregate([{ $match: saleMatch }, { $group: { _id: null, net: { $sum: '$total' }, tax: { $sum: '$tax' }, n: { $sum: 1 } } }]),
    Payment.aggregate([{ $match: { status: 'SUCCESS', ...createdIn } }, { $group: { _id: '$method', total: { $sum: '$amount' } } }]),
    Refund
      ? Refund.aggregate([{ $match: { status: 'COMPLETED', ...createdIn } }, { $group: { _id: null, total: { $sum: '$amount' } } }])
      : Promise.resolve([]),
    Sale.aggregate([
      { $match: saleMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } }, net: { $sum: '$total' }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Sale.aggregate([
      { $match: saleMatch },
      { $group: { _id: '$businessId', net: { $sum: '$total' }, n: { $sum: 1 } } },
      { $sort: { net: -1 } },
      { $limit: 10 },
      ...lookupOne(Business, '_id', 'biz'),
      { $project: { name: '$biz.name', netSales: cents('$net'), transactions: '$n' } },
    ]),
    Business.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    User.countDocuments({ businessId: { $exists: true, $ne: null } }),
    Branch.countDocuments({}),
    Product.countDocuments({ status: 'active' }),
    Business.countDocuments(createdIn),
    Business.aggregate([
      { $sort: { createdAt: -1 } },
      { $limit: 6 },
      ownerLookup(),
      { $project: { name: 1, status: 1, createdAt: 1, ownerName: { $arrayElemAt: ['$ow.name', 0] } } },
    ]),
  ]);

  const statusCount = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  const totalBusinesses = byStatus.reduce((s, x) => s + x.n, 0);

  return {
    totals: {
      businesses: totalBusinesses,
      activeBusinesses: statusCount.active || 0,
      suspendedBusinesses: statusCount.suspended || 0,
      employees, branches, products, newBusinesses,
    },
    sales: {
      transactions: sum[0]?.n || 0,
      netSales: (sum[0]?.net || 0) / 100,
      totalTax: (sum[0]?.tax || 0) / 100,
      totalRefunds: (refunds[0]?.total || 0) / 100,
      paymentBreakdown: pay.map((p) => ({ method: p._id, total: p.total / 100 })),
    },
    trend: trend.map((t) => ({ date: t._id, netSales: t.net / 100, transactionCount: t.n })),
    topBusinesses: top,
    recentBusinesses: recent,
  };
}

/* ----------------------------- businesses ----------------------------- */
async function listBusinesses(q) {
  const match = {};
  if (q.status) match.status = q.status;
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    match.$or = [{ name: re }, { phone: re }, { email: re }, { kraPin: re }];
  }
  const enrich = [
    countLookup(Branch, 'br', { status: 'active' }),
    countLookup(User, 'em'),
    countLookup(Product, 'pr', { status: 'active' }),
    {
      $lookup: {
        from: coll(Sale),
        let: { bid: '$_id' },
        pipeline: [
          { $match: { saleStatus: 'COMPLETED', $expr: { $eq: ['$businessId', '$$bid'] } } },
          { $group: { _id: null, net: { $sum: '$total' }, n: { $sum: 1 } } },
        ],
        as: 'sl',
      },
    },
    ownerLookup(),
    {
      $project: {
        name: 1, phone: 1, email: 1, status: 1, subscriptionPlan: 1, subscriptionStatus: 1, createdAt: 1,
        ownerName: { $arrayElemAt: ['$ow.name', 0] },
        branchCount: { $ifNull: [{ $arrayElemAt: ['$br.n', 0] }, 0] },
        employeeCount: { $ifNull: [{ $arrayElemAt: ['$em.n', 0] }, 0] },
        productCount: { $ifNull: [{ $arrayElemAt: ['$pr.n', 0] }, 0] },
        transactions: { $ifNull: [{ $arrayElemAt: ['$sl.n', 0] }, 0] },
        netSales: cents({ $ifNull: [{ $arrayElemAt: ['$sl.net', 0] }, 0] }),
      },
    },
  ];
  return paged(Business, match, { createdAt: -1 }, paging(q), enrich);
}

async function getBusiness(id) {
  const business = await Business.findById(id).lean();
  if (!business) throw ApiError.notFound('Business not found');
  const bid = business._id;
  const okSale = { businessId: bid, saleStatus: 'COMPLETED' };

  const [owner, branches, employees, products, all, today, last] = await Promise.all([
    User.findOne({ businessId: bid, role: ROLES.OWNER }).select('name phone email lastLoginAt').lean(),
    Branch.countDocuments({ businessId: bid }),
    User.countDocuments({ businessId: bid }),
    Product.countDocuments({ businessId: bid, status: 'active' }),
    Sale.aggregate([{ $match: okSale }, { $group: { _id: null, net: { $sum: '$total' }, n: { $sum: 1 } } }]),
    Sale.aggregate([{ $match: { ...okSale, createdAt: { $gte: startOfTodayEAT() } } }, { $group: { _id: null, net: { $sum: '$total' } } }]),
    Sale.findOne(okSale).sort({ createdAt: -1 }).select('createdAt').lean(),
  ]);

  return {
    business,
    owner,
    stats: {
      branches, employees, products,
      transactions: all[0]?.n || 0,
      netSales: (all[0]?.net || 0) / 100,
      salesToday: (today[0]?.net || 0) / 100,
      lastSaleAt: last?.createdAt || null,
    },
  };
}

async function setBusinessStatus(adminUser, id, status) {
  const business = await Business.findById(id);
  if (!business) throw ApiError.notFound('Business not found');
  const oldStatus = business.status;
  business.status = status;
  await business.save();

  await AuditLog.create({
    businessId: business._id,
    userId: adminUser._id,
    action: status === 'suspended' ? 'admin.business.suspend' : 'admin.business.reactivate',
    entityType: 'Business',
    entityId: business._id,
    oldValue: { status: oldStatus },
    newValue: { status },
  });
  return { _id: business._id, status: business.status };
}

/* -------------------------------- sales -------------------------------- */
const saleLookups = () => [
  ...lookupOne(Business, 'businessId', 'biz'),
  ...lookupOne(Branch, 'branchId', 'branch'),
  ...lookupOne(User, 'cashierId', 'cashier'),
  ...lookupOne(Customer, 'customerId', 'customer'),
];

async function listSales(q) {
  const match = {};
  if (q.businessId) match.businessId = oid(q.businessId);
  if (q.paymentStatus) match.paymentStatus = q.paymentStatus;
  if (q.saleStatus) match.saleStatus = q.saleStatus;
  const range = dateRange(q.from, q.to);
  if (range) match.createdAt = range;
  if (q.search) match.receiptNumber = new RegExp(esc(q.search), 'i');

  const enrich = [
    ...saleLookups(),
    {
      $project: {
        receiptNumber: 1, createdAt: 1, paymentStatus: 1, saleStatus: 1,
        total: cents('$total'),
        businessName: '$biz.name', branchName: '$branch.name',
        cashierName: '$cashier.name', customerName: '$customer.name',
      },
    },
  ];
  return paged(Sale, match, { createdAt: -1 }, paging(q), enrich);
}

async function getSale(id) {
  const [sale] = await Sale.aggregate([
    { $match: { _id: oid(id) } },
    ...saleLookups(),
    {
      $project: {
        receiptNumber: 1, createdAt: 1, paymentStatus: 1, saleStatus: 1, cancelReason: 1,
        subtotal: cents('$subtotal'),
        tax: cents('$tax'),
        total: cents('$total'),
        balance: cents('$balance'),
        totalDiscount: cents({ $add: ['$itemDiscount', '$cartDiscount'] }),
        businessName: '$biz.name', branchName: '$branch.name',
        cashierName: '$cashier.name', customerName: '$customer.name',
        items: {
          $map: {
            input: '$items', as: 'i',
            in: { nameSnapshot: '$$i.nameSnapshot', quantity: '$$i.quantity', total: cents('$$i.total') },
          },
        },
      },
    },
  ]);
  if (!sale) throw ApiError.notFound('Sale not found');

  const payments = await Payment.find({ saleId: sale._id }).select('method reference amount status').lean();
  sale.payments = payments.map((p) => ({ method: p.method, reference: p.reference, status: p.status, amount: p.amount / 100 }));
  return { sale };
}

/* ------------------------------ employees ------------------------------ */
async function listEmployees(q) {
  const match = { businessId: q.businessId ? oid(q.businessId) : { $exists: true, $ne: null } };
  if (q.role) match.role = q.role;
  if (q.status) match.status = q.status;
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    match.$or = [{ name: re }, { phone: re }, { email: re }, { employeeCode: re }];
  }
  const enrich = [
    ...lookupOne(Business, 'businessId', 'biz'),
    // explicit whitelist - hashes and token versions must never leave the server
    { $project: { name: 1, employeeCode: 1, role: 1, phone: 1, email: 1, status: 1, lastLoginAt: 1, createdAt: 1, businessName: '$biz.name' } },
  ];
  return paged(User, match, { createdAt: -1 }, paging(q), enrich);
}

async function setEmployeeStatus(adminUser, id, status) {
  const user = await User.findById(id);
  if (!user || !user.businessId) throw ApiError.notFound('Employee not found');
  if (user.role === ROLES.OWNER || user.role === ROLES.SUPER_ADMIN) {
    throw ApiError.badRequest('Suspend the whole business instead of its owner', 'CANNOT_CHANGE_OWNER');
  }
  user.status = status;
  if (status !== 'active') user.refreshTokenVersion += 1; // force logout everywhere
  await user.save();

  await AuditLog.create({
    businessId: user.businessId,
    userId: adminUser._id,
    action: 'admin.employee.status_change',
    entityType: 'User',
    entityId: user._id,
    newValue: { status },
  });
  return { _id: user._id, status: user.status };
}

/* ------------------------------- products ------------------------------- */
async function listProducts(q) {
  const match = {};
  if (q.businessId) match.businessId = oid(q.businessId);
  if (q.status) match.status = q.status;
  if (q.search) {
    const re = new RegExp(esc(q.search), 'i');
    match.$or = [{ name: re }, { sku: re }, { barcode: re }, { brand: re }];
  }
  const enrich = [
    ...lookupOne(Business, 'businessId', 'biz'),
    ...lookupOne(Category, 'categoryId', 'cat'),
    {
      $lookup: {
        from: coll(ProductVariant),
        let: { pid: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$productId', '$$pid'] }, { $eq: ['$status', 'active'] }] } } },
          { $project: { _id: 1 } },
        ],
        as: 'variants',
      },
    },
    {
      $project: {
        name: 1, sku: 1, barcode: 1, hasVariants: 1, status: 1, variants: 1,
        costPrice: cents('$costPrice'), sellingPrice: cents('$sellingPrice'),
        businessName: '$biz.name', categoryName: '$cat.name',
      },
    },
  ];
  return paged(Product, match, { createdAt: -1 }, paging(q), enrich);
}

/* ------------------------------- audit log ------------------------------- */
async function listAuditLogs(q) {
  const match = {};
  if (q.businessId) match.businessId = oid(q.businessId);
  if (q.search) match.action = new RegExp(`^${esc(q.search)}`, 'i');
  const range = dateRange(q.from, q.to);
  if (range) match.timestamp = range;

  const enrich = [
    ...lookupOne(Business, 'businessId', 'biz'),
    ...lookupOne(User, 'userId', 'usr'),
    {
      $project: {
        timestamp: 1, action: 1, entityType: 1, entityId: 1, ipAddress: 1,
        businessName: '$biz.name', userName: '$usr.name', userRole: '$usr.role',
      },
    },
  ];
  return paged(AuditLog, match, { timestamp: -1 }, paging(q), enrich);
}

module.exports = {
  getOverview, listBusinesses, getBusiness, setBusinessStatus,
  listSales, getSale, listEmployees, setEmployeeStatus, listProducts, listAuditLogs,
};