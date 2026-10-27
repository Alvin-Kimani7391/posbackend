const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const svc = require('../services/addon.service');
const wrap = (message, fn, status = 200) => catchAsync(async (req, res) => sendSuccess(res, status, message, await fn(req)));
// owner (/api/v1/billing/addons)
exports.list = wrap('Premium features fetched', (r) => svc.ownerView(r.businessId, r.user));
exports.subscribe = wrap('Upgrade started', (r) => svc.subscribe(r.businessId, r.user, r.params.key), 201);
exports.cancel = wrap('Feature cancelled', (r) => svc.cancel(r.businessId, r.user, r.params.key, r.body));
exports.resume = wrap('Feature resumed', (r) => svc.resume(r.businessId, r.user, r.params.key));
// admin (/api/v1/admin/billing/addons)
exports.adminList = wrap('Features fetched', () => svc.adminListCatalog());
exports.adminCreate = wrap('Feature created', async (r) => ({ addon: await svc.adminCreate(r.user, r.body) }), 201);
exports.adminUpdate = wrap('Feature saved', async (r) => ({ addon: await svc.adminUpdate(r.user, r.params.key, r.body) }));
exports.adminActive = wrap('Feature updated', async (r) => ({ addon: await svc.adminSetActive(r.user, r.params.key, r.body.isActive) }));
exports.adminRemove = wrap('Feature deleted', (r) => svc.adminRemove(r.user, r.params.key));
exports.adminSeed = wrap('Starter features loaded', (r) => svc.adminSeedStarter(r.user));
exports.adminGrantExisting = wrap('Existing customers granted', (r) => svc.adminGrantExisting(r.user, r.params.key, r.body));
exports.adminPromote = wrap('Promotion sent', (r) => svc.adminPromote(r.user, r.body));
exports.adminBasePlans = wrap('Plans fetched', () => svc.adminBasePlans());
exports.adminSetBasePlan = wrap('Base plan saved', (r) => svc.adminSetBasePlan(r.user, r.body));
exports.adminBusiness = wrap('Business features fetched', (r) => svc.adminBusinessView(r.params.businessId));
exports.adminGrant = wrap('Access granted', async (r) => ({ ok: !!(await svc.adminGrant(r.user, r.params.businessId, r.params.key, r.body)) }));
exports.adminRevoke = wrap('Access removed', async (r) => ({ ok: !!(await svc.adminRevoke(r.user, r.params.businessId, r.params.key)) }));
exports.adminPrice = wrap('Price saved', async (r) => { await svc.adminSetPrice(r.user, r.params.businessId, r.params.key, r.body.priceCents); return { ok: true }; });
