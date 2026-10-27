/**
 * Returnable bottles and crates.
 *  - The deposit is charged by the till as an ordinary line of the container's "deposit product" (so it prints on the receipt and is taxed/paid like anything else).
 *  - Sales record containers going out and empties coming back (movements). In ENFORCE mode the server checks the deposit lines: deposit units = (containers sold - empties returned).
 *  - Walk-in empties refunds, supplier receipts/returns, and customer + supplier balances live here.
 */
const ContainerType = require('../../models/ContainerType');
const ContainerMovement = require('../../models/ContainerMovement');
const Product = require('../../models/Product');
const Customer = require('../../models/Customer');
const Supplier = require('../../models/Supplier');
const CashShift = require('../../models/CashShift');
const Payment = require('../../models/Payment');
const AuditLog = require('../../models/AuditLog');
const productSvc = require('../product.service');
const { nextSequence, pad } = require('../../models/Counter');
const withTx = require('../../utils/withTx');
const { assertBranchAccess } = require('../../utils/branchAccess');
const { hasPermission } = require('../../utils/permissionCheck');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

const IN = ['RETURNED_IN']; // customer -> shop
async function createType(businessId, user, { name, kind, deposit, createDepositProduct = true }) {
  let type;
  try { type = await ContainerType.create({ businessId, name, kind, deposit }); } catch (e) { if (e.code === 11000) throw ApiError.conflict('A container with this name already exists', 'DUPLICATE_CONTAINER'); throw e; }
  if (createDepositProduct && deposit > 0) {
    const seq = await nextSequence(businessId, 'sku:business');
    const p = await productSvc.createProduct(businessId, user._id, { name: `Deposit: ${name}`, sku: `DEP-${pad(seq, 6)}`, unit: 'piece', productType: 'service', trackInventory: false, costPrice: 0, sellingPrice: deposit, taxRate: 0, taxCategory: 'exempt' });
    type.depositProductId = p._id; await type.save();
  }
  await AuditLog.create({ businessId, userId: user._id, action: 'liquor.container.create', entityType: 'ContainerType', entityId: type._id, newValue: { name, deposit } });
  return type;
}

async function updateType(businessId, user, id, input) {
  const t = await ContainerType.findOne({ _id: id, businessId });
  if (!t) throw ApiError.notFound('Container type not found');
  Object.assign(t, input);
  await t.save();
  if (input.deposit != null && t.depositProductId) await Product.updateOne({ _id: t.depositProductId, businessId }, { $set: { sellingPrice: t.deposit, updatedBy: user._id } });
  return t;
}

const sum = (rows, types) => rows.filter((r) => types.includes(r._id)).reduce((s, r) => s + r.q, 0);
/** Balances per container type: with customers, in the shop, owed to suppliers. */
async function list(businessId) {
  const mongoose = require('mongoose');
  const [types, mv] = await Promise.all([ContainerType.find({ businessId }).sort({ name: 1 }), ContainerMovement.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(String(businessId)) } }, { $group: { _id: { c: '$containerTypeId', t: '$type', r: '$reverses' }, q: { $sum: '$quantity' } } }])]);
  return types.map((t) => {
    const rows = mv.filter((m) => String(m._id.c) === String(t._id));
    const net = (type) => rows.filter((r) => r._id.t === type).reduce((s, r) => s + r.q, 0) - rows.filter((r) => r._id.t === 'REVERSAL' && r._id.r === type).reduce((s, r) => s + r.q, 0);
    const out = net('SOLD_OUT') - net('RETURNED_IN');
    return { ...t.toJSON(), withCustomers: out, owedToSuppliers: net('SUPPLIER_RECEIVED') - net('SUPPLIER_RETURNED'), depositHeld: fromCents(Math.max(0, out) * t.deposit) };
  });
}

async function customerBalances(businessId, containerTypeId) {
  const mongoose = require('mongoose');
  const rows = await ContainerMovement.aggregate([{ $match: { businessId: new mongoose.Types.ObjectId(String(businessId)), containerTypeId: new mongoose.Types.ObjectId(String(containerTypeId)), customerId: { $ne: null } } },
    { $group: { _id: '$customerId', out: { $sum: { $cond: [{ $eq: ['$type', 'SOLD_OUT'] }, '$quantity', { $cond: [{ $and: [{ $eq: ['$type', 'REVERSAL'] }, { $eq: ['$reverses', 'SOLD_OUT'] }] }, { $multiply: ['$quantity', -1] }, 0] }] } }, back: { $sum: { $cond: [{ $eq: ['$type', 'RETURNED_IN'] }, '$quantity', { $cond: [{ $and: [{ $eq: ['$type', 'REVERSAL'] }, { $eq: ['$reverses', 'RETURNED_IN'] }] }, { $multiply: ['$quantity', -1] }, 0] }] } } } }]);
  const owing = rows.filter((r) => r.out - r.back > 0);
  const cs = await Customer.find({ _id: { $in: owing.map((r) => r._id) }, businessId }).select('name phone').lean(); const C = new Map(cs.map((c) => [String(c._id), c]));
  return owing.map((r) => ({ customerId: r._id, name: (C.get(String(r._id)) || {}).name, phone: (C.get(String(r._id)) || {}).phone, owes: r.out - r.back })).sort((a, b) => b.owes - a.owes);
}

async function movements(businessId, { containerTypeId, page = 1, limit = 50 }) {
  const q = { businessId }; if (containerTypeId) q.containerTypeId = containerTypeId;
  const [rows, total] = await Promise.all([ContainerMovement.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('containerTypeId', 'name').populate('customerId', 'name').populate('supplierId', 'name').lean(), ContainerMovement.countDocuments(q)]);
  return { total, page, movements: rows.map((m) => ({ ...m, amount: m.amount != null ? fromCents(m.amount) : undefined })) };
}

/** Walk-in empties refund: the customer brings empties back for their deposit. */
async function refundDeposit(businessId, user, { containerTypeId, quantity, method = 'CASH', branchId, customerId, reference, note }) {
  assertBranchAccess(user, branchId);
  const type = await ContainerType.findOne({ _id: containerTypeId, businessId });
  if (!type) throw ApiError.notFound('Container type not found');
  if (!(type.deposit > 0)) throw ApiError.badRequest('This container has no deposit to refund', 'NO_DEPOSIT');
  if (customerId && !(await Customer.exists({ _id: customerId, businessId }))) throw ApiError.badRequest('Customer not found', 'CUSTOMER_NOT_FOUND');
  const bal = (await list(businessId)).find((x) => String(x._id) === String(type._id));
  if (quantity > Math.max(0, bal.withCustomers) && !hasPermission(user, 'liquor.override')) throw ApiError.badRequest(`Only ${Math.max(0, bal.withCustomers)} of these are out with customers. A manager can approve more.`, 'MORE_THAN_OUTSTANDING');
  const amount = quantity * type.deposit;
  return withTx(async (session) => {
    const shift = await CashShift.findOne({ businessId, branchId, cashierId: user._id, status: 'OPEN' }).session(session);
    if (method === 'CASH' && !shift) throw ApiError.badRequest('Open a cash shift before paying out cash', 'SHIFT_REQUIRED');
    await ContainerMovement.create([{ businessId, branchId, containerTypeId, type: 'RETURNED_IN', quantity, customerId, createdBy: user._id, note }, { businessId, branchId, containerTypeId, type: 'REFUND_PAID', quantity, customerId, amount, createdBy: user._id, note }], { session, ordered: true });
    await ContainerType.updateOne({ _id: containerTypeId, businessId }, { $inc: { emptiesOnHand: quantity } }, { session });
    const [payment] = await Payment.create([{ businessId, branchId, shiftId: shift && shift._id, customerId, method, provider: 'manual', amount, reference, status: 'REFUNDED', initiatedBy: user._id, completedAt: new Date(), metadata: { kind: 'EMPTIES_DEPOSIT_REFUND', containerTypeId, quantity } }], { session });
    await AuditLog.create([{ businessId, branchId, userId: user._id, action: 'liquor.empties.refund', entityType: 'ContainerType', entityId: containerTypeId, newValue: { quantity, amount } }], { session });
    return { refunded: fromCents(amount), quantity, paymentId: payment._id };
  });
}

async function supplierReceive(businessId, user, { containerTypeId, quantity, supplierId, branchId, note }) {
  if (!(await ContainerType.exists({ _id: containerTypeId, businessId }))) throw ApiError.notFound('Container type not found');
  if (supplierId && !(await Supplier.exists({ _id: supplierId, businessId }))) throw ApiError.badRequest('Supplier not found', 'SUPPLIER_NOT_FOUND');
  const m = await ContainerMovement.create({ businessId, branchId, containerTypeId, type: 'SUPPLIER_RECEIVED', quantity, supplierId, note, createdBy: user._id });
  return m;
}

async function supplierReturn(businessId, user, { containerTypeId, quantity, supplierId, branchId, note }) {
  const t = await ContainerType.findOne({ _id: containerTypeId, businessId });
  if (!t) throw ApiError.notFound('Container type not found');
  if (supplierId && !(await Supplier.exists({ _id: supplierId, businessId }))) throw ApiError.badRequest('Supplier not found', 'SUPPLIER_NOT_FOUND');
  const upd = await ContainerType.updateOne({ _id: containerTypeId, businessId, emptiesOnHand: { $gte: quantity } }, { $inc: { emptiesOnHand: -quantity } });
  if (!upd.modifiedCount) throw ApiError.badRequest(`Only ${t.emptiesOnHand} empties are in the shop`, 'NOT_ENOUGH_EMPTIES');
  return ContainerMovement.create({ businessId, branchId, containerTypeId, type: 'SUPPLIER_RETURNED', quantity, supplierId, note, createdBy: user._id });
}

async function adjust(businessId, user, { containerTypeId, delta, reason, branchId }) {
  const t = await ContainerType.findOne({ _id: containerTypeId, businessId });
  if (!t) throw ApiError.notFound('Container type not found');
  if (t.emptiesOnHand + delta < 0) throw ApiError.badRequest('That would make the empties in the shop negative', 'NEGATIVE_EMPTIES');
  t.emptiesOnHand += delta; await t.save();
  await ContainerMovement.create({ businessId, branchId, containerTypeId, type: 'ADJUST', quantity: Math.abs(delta), note: `${delta >= 0 ? '+' : '-'}${Math.abs(delta)}: ${reason}`, createdBy: user._id });
  await AuditLog.create({ businessId, userId: user._id, action: 'liquor.empties.adjust', entityType: 'ContainerType', entityId: containerTypeId, newValue: { delta, reason } });
  return t;
}

// ---- sale hooks (called by liquor-guard inside the sale transaction) ----
async function recordSale({ businessId, branchId, saleId, customerId, userId, out, returned, session }) {
  const docs = [];
  for (const [cid, q] of Object.entries(out)) if (q > 0) docs.push({ businessId, branchId, containerTypeId: cid, type: 'SOLD_OUT', quantity: q, customerId, saleId, createdBy: userId });
  for (const [cid, q] of Object.entries(returned)) if (q > 0) { docs.push({ businessId, branchId, containerTypeId: cid, type: 'RETURNED_IN', quantity: q, customerId, saleId, createdBy: userId }); await ContainerType.updateOne({ _id: cid, businessId }, { $inc: { emptiesOnHand: q } }, { session }); }
  if (docs.length) await ContainerMovement.create(docs, { session, ordered: true });
}
async function reverseSale({ businessId, saleId, userId, session }) {
  const mv = await ContainerMovement.find({ businessId, saleId, type: { $in: ['SOLD_OUT', 'RETURNED_IN'] } }).session(session);
  const done = await ContainerMovement.find({ businessId, saleId, type: 'REVERSAL' }).session(session);
  if (done.length || !mv.length) return;
  const docs = [];
  for (const m of mv) { docs.push({ businessId, branchId: m.branchId, containerTypeId: m.containerTypeId, type: 'REVERSAL', reverses: m.type, quantity: m.quantity, customerId: m.customerId, saleId, createdBy: userId, note: 'Sale cancelled' }); if (m.type === 'RETURNED_IN') await ContainerType.updateOne({ _id: m.containerTypeId, businessId }, { $inc: { emptiesOnHand: -m.quantity } }, { session }); }
  await ContainerMovement.create(docs, { session, ordered: true });
}

module.exports = { createType, updateType, list, customerBalances, movements, refundDeposit, supplierReceive, supplierReturn, adjust, recordSale, reverseSale, IN, sum };
