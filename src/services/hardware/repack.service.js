/** Repackaging: turn stock of one product into another (a 25 kg sack of nails into 1 kg packets). Cost moves with the stock. Money = integer cents. */
const Product = require('../../models/Product');
const RepackRecord = require('../../models/RepackRecord');
const HardwareProfile = require('../../models/HardwareProfile');
const AuditLog = require('../../models/AuditLog');
const { applyStockChange, receiveStock } = require('../inventory.service');
const { assertBranchAccess } = require('../../utils/branchAccess');
const withTx = require('../../utils/withTx');
const { fromCents } = require('../../utils/money');
const ApiError = require('../../utils/ApiError');

/** pure: cost per target unit when sourceQty at sourceCost becomes targetQty (wastage is absorbed by the good units) */
const targetUnitCost = (sourceQty, sourceCost, targetQty) => Math.round((sourceQty * sourceCost) / targetQty);

async function repack(businessId, user, { branchId, sourceProductId, sourceQty, targetProductId, targetQty, wastageQty = 0, note }) {
  assertBranchAccess(user, branchId);
  if (String(sourceProductId) === String(targetProductId)) throw ApiError.badRequest('Source and target are the same product. Units convert on their own, no repack needed.', 'SAME_PRODUCT');
  const [src, tgt] = await Promise.all([Product.findOne({ _id: sourceProductId, businessId, status: 'active' }).select('name costPrice trackInventory unit'), Product.findOne({ _id: targetProductId, businessId, status: 'active' }).select('name trackInventory unit')]);
  if (!src || !tgt) throw ApiError.notFound('Product not found');
  if (src.trackInventory === false || tgt.trackInventory === false) throw ApiError.badRequest('Both products must be stock-tracked', 'NOT_TRACKED');
  if (wastageQty > sourceQty) throw ApiError.badRequest('Wastage is more than the quantity used', 'INVALID_WASTAGE');
  const profs = await HardwareProfile.find({ businessId, productId: { $in: [src._id, tgt._id] } }).select('productId measurable').lean(); const M = new Map(profs.map((p) => [String(p.productId), p.measurable]));
  for (const [p, q] of [[src, sourceQty], [tgt, targetQty]]) if (!M.get(String(p._id)) && !Number.isInteger(q)) throw ApiError.badRequest(`${p.name} is counted in whole units`, 'WHOLE_QUANTITY_ONLY');
  const unitCost = targetUnitCost(sourceQty, src.costPrice, targetQty);
  await withTx((session) => applyStockChange({ businessId, branchId, productId: sourceProductId, quantityDelta: -sourceQty, type: 'ADJUSTMENT_OUT', referenceType: 'Repack', reason: `Repacked into ${tgt.name}`, performedBy: user._id, session }));
  try { await receiveStock(businessId, branchId, user._id, { productId: targetProductId, quantity: targetQty, costPrice: unitCost, reason: `Repacked from ${src.name}` }); }
  catch (e) { await withTx((session) => applyStockChange({ businessId, branchId, productId: sourceProductId, quantityDelta: sourceQty, type: 'ADJUSTMENT_IN', referenceType: 'Repack', reason: 'Repack failed, stock put back', performedBy: user._id, session })); throw e; }
  const rec = await RepackRecord.create({ businessId, branchId, sourceProductId, sourceQty, targetProductId, targetQty, wastageQty, costMoved: Math.round(sourceQty * src.costPrice), note, createdBy: user._id });
  await AuditLog.create({ businessId, branchId, userId: user._id, action: 'hardware.repack', entityType: 'RepackRecord', entityId: rec._id, newValue: { sourceQty, targetQty, wastageQty } });
  return { record: rec, costPerTargetUnit: fromCents(unitCost) };
}
async function list(businessId, { branchId, page = 1, limit = 30 }) { const q = { businessId }; if (branchId) q.branchId = branchId; const [rows, total] = await Promise.all([RepackRecord.find(q).populate('sourceProductId targetProductId', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit), RepackRecord.countDocuments(q)]); return { total, page, rows }; }
module.exports = { targetUnitCost, repack, list };
