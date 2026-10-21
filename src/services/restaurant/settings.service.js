const RestaurantSettings = require('../../models/RestaurantSettings');
const RestaurantArea = require('../../models/RestaurantArea');
const KitchenStation = require('../../models/KitchenStation');
const RestaurantTable = require('../../models/RestaurantTable');
const MenuItem = require('../../models/MenuItem');
const ApiError = require('../../utils/ApiError');
const Business = require('../../models/Business');
const C = require('./common');

async function getSettings(businessId) { return (await C.getContext(businessId)).settings; }
async function updateSettings(businessId, userId, patch) {
  const { settings } = await C.getContext(businessId);
  if (patch.selfService && patch.selfService.branchId) await C.assertBranch(businessId, patch.selfService.branchId);
  const before = settings.toObject();
  const merge = (target, src) => { for (const [k, v] of Object.entries(src)) { if (v && typeof v === 'object' && !Array.isArray(v)) { if (!target[k]) target[k] = {}; merge(target[k], v); } else target[k] = v; } };
  for (const [k, v] of Object.entries(patch)) { if (v && typeof v === 'object' && !Array.isArray(v)) { const cur = settings[k] && settings[k].toObject ? settings[k].toObject() : (settings[k] || {}); merge(cur, v); settings[k] = cur; } else settings[k] = v; }
  await settings.save();
  if (patch.serviceMode) {                                           // RESTAURANT / ACCOMMODATION / BOTH only switches the accommodation module on or off; nothing is deleted
    await Business.updateOne({ _id: businessId }, { $set: { 'featureSettings.accommodation': patch.serviceMode !== 'RESTAURANT' } });
    require('../../utils/businessContext').invalidateBusinessContext(businessId);
  }
  await C.audit({ businessId, userId, action: 'restaurant.settings.update', entityType: 'RestaurantSettings', entityId: settings._id, oldValue: { stockDepletionEvent: before.stockDepletionEvent, serviceCharge: before.serviceCharge, discounts: before.discounts }, newValue: patch });
  return settings;
}

const listAreas = (businessId, branchId) => RestaurantArea.find({ businessId, ...(branchId ? { branchId } : {}), status: 'active' }).sort({ sortOrder: 1, name: 1 });
async function createArea(businessId, userId, input) { await C.assertBranch(businessId, input.branchId); return RestaurantArea.create({ ...input, businessId }); }
async function updateArea(businessId, id, input) { const a = await RestaurantArea.findOne({ _id: id, businessId }); if (!a) throw ApiError.notFound('Area not found'); Object.assign(a, input); await a.save(); return a; }
async function removeArea(businessId, id) {
  if (await RestaurantTable.exists({ businessId, areaId: id, active: true })) throw ApiError.conflict('Move or remove the tables in this area first', 'AREA_NOT_EMPTY');
  const a = await RestaurantArea.findOne({ _id: id, businessId }); if (!a) throw ApiError.notFound('Area not found'); a.status = 'inactive'; await a.save(); return a;
}

async function listStations(businessId, branchId) { if (branchId) await C.ensureStations(businessId, branchId); return KitchenStation.find({ businessId, ...(branchId ? { branchId } : {}), status: 'active' }).sort({ name: 1 }); }
async function createStation(businessId, input) {
  await C.assertBranch(businessId, input.branchId);
  await C.ensureStations(businessId, input.branchId);
  if (input.isDefault) await KitchenStation.updateMany({ businessId, branchId: input.branchId }, { $set: { isDefault: false } });
  return KitchenStation.create({ ...input, businessId });
}
async function updateStation(businessId, id, input) {
  const s = await KitchenStation.findOne({ _id: id, businessId }); if (!s) throw ApiError.notFound('Station not found');
  if (input.isDefault) await KitchenStation.updateMany({ businessId, branchId: s.branchId, _id: { $ne: s._id } }, { $set: { isDefault: false } });
  Object.assign(s, input); await s.save(); return s;
}
async function removeStation(businessId, id) {
  const s = await KitchenStation.findOne({ _id: id, businessId }); if (!s) throw ApiError.notFound('Station not found');
  if (s.isDefault) throw ApiError.conflict('Choose another default station first', 'DEFAULT_STATION');
  if (await MenuItem.exists({ businessId, stationCode: s.code, status: 'active' })) throw ApiError.conflict('Menu items still route to this station', 'STATION_IN_USE');
  s.status = 'inactive'; await s.save(); return s;
}
module.exports = { getSettings, updateSettings, listAreas, createArea, updateArea, removeArea, listStations, createStation, updateStation, removeStation };
