/**
 * Live TV management for owners / managers. Mounted at /api/v1/tv.
 * authenticate (tenant) + restaurantOrdering feature + granular tv.* permissions; screens are also branch-scoped inside the service.
 */
const router = require('express').Router();
const { z } = require('zod');
const validate = require('../middleware/validate');
const requireFeature = require('../middleware/requireFeature');
const catchAsync = require('../utils/catchAsync');
const { sendSuccess } = require('../utils/ApiResponse');
const { authenticate, requirePermission: P } = require('../middleware/auth');
const { uploadTvImage } = require('../middleware/tvUpload');
const v = require('../validators/tv.validator');
const svc = require('../services/tv/tv.service');

router.use(authenticate, requireFeature('restaurantOrdering'));
const h = (fn, msg = 'OK', status = 200) => catchAsync(async (req, res) => sendSuccess(res, status, msg, await fn(req)));
const id = { params: v.idParam }; const b = (r) => r.businessId; const u = (r) => r.user;

router.get('/overview', P('tv.view'), h((r) => svc.overview(b(r), u(r))));
router.get('/options', P('tv.view'), h((r) => svc.options(b(r), u(r))));
router.get('/audit', P('tv.view'), h((r) => svc.audit(b(r))));
router.get('/settings', P('tv.view'), h((r) => svc.getSettings(b(r))));
router.put('/settings', P('tv.manage'), validate({ body: v.settingsBody }), h((r) => svc.updateSettings(b(r), u(r), r.body), 'Display settings saved'));

// playlists: draft -> preview -> publish -> rollback
router.get('/playlists', P('tv.view'), h((r) => svc.listPlaylists(b(r))));
router.post('/playlists', P('tv.manage'), validate({ body: v.playlistBody }), h(async (r) => { const { slides, ...rest } = r.body; const p = await svc.createPlaylist(b(r), u(r), rest); return slides && slides.length ? svc.setSlides(b(r), u(r), p._id, slides) : p; }, 'Playlist created', 201));
router.get('/playlists/:id', P('tv.view'), validate(id), h((r) => svc.getPlaylist(b(r), r.params.id)));
router.put('/playlists/:id', P('tv.manage'), validate({ ...id, body: v.playlistUpdate }), h((r) => svc.updatePlaylist(b(r), u(r), r.params.id, r.body), 'Playlist saved'));
router.put('/playlists/:id/slides', P('tv.manage'), validate({ ...id, body: v.slidesBody }), h((r) => svc.setSlides(b(r), u(r), r.params.id, r.body.slides), 'Draft saved'));
router.delete('/playlists/:id', P('tv.manage'), validate(id), h((r) => svc.removePlaylist(b(r), u(r), r.params.id), 'Playlist removed'));
router.get('/playlists/:id/preview', P('tv.view'), validate({ ...id, query: v.previewQuery }), h((r) => svc.previewDraft(b(r), u(r), r.params.id, r.query.branchId)));
router.post('/playlists/:id/publish', P('tv.publish'), validate({ ...id, body: v.publishBody }), h((r) => svc.publish(b(r), u(r), r.params.id, r.body.note), 'Published to the screens'));
router.get('/playlists/:id/history', P('tv.view'), validate(id), h((r) => svc.history(b(r), r.params.id)));
router.post('/playlists/:id/rollback', P('tv.publish'), validate({ ...id, body: v.rollbackBody }), h((r) => svc.rollback(b(r), u(r), r.params.id, r.body.version), 'Rolled back and published'));

// promotions (advertised on TV AND charged at the till)
router.get('/promotions', P('tv.view'), h((r) => svc.listPromos(b(r))));
router.post('/promotions', P('tv.manage'), validate({ body: v.promoBody }), h((r) => svc.savePromo(b(r), u(r), r.body), 'Promotion created', 201));
router.put('/promotions/:id', P('tv.manage'), validate({ ...id, body: v.promoUpdate }), h((r) => svc.savePromo(b(r), u(r), r.body, r.params.id), 'Promotion saved'));
router.post('/promotions/:id/toggle', P('tv.manage'), validate({ ...id, body: v.toggleBody }), h((r) => svc.togglePromo(b(r), u(r), r.params.id, r.body.active), 'Promotion updated'));
router.delete('/promotions/:id', P('tv.manage'), validate(id), h((r) => svc.removePromo(b(r), u(r), r.params.id), 'Promotion deleted'));

// media
router.get('/media', P('tv.view'), h((r) => svc.listMedia(b(r))));
router.post('/media', P('tv.manage'), uploadTvImage, h((r) => svc.addMedia(b(r), u(r), r.file, r.body && r.body.name), 'Image uploaded', 201));
router.delete('/media/:id', P('tv.manage'), validate(id), h((r) => svc.removeMedia(b(r), u(r), r.params.id), 'Image removed'));

// screens
router.get('/screens', P('tv.view'), h((r) => svc.listScreens(b(r), u(r))));
router.post('/screens', P('tv.screens'), validate({ body: v.screenBody }), h((r) => svc.createScreen(b(r), u(r), r.body), 'Screen added. Enter the code on the TV.', 201));
router.put('/screens/:id', P('tv.screens'), validate({ ...id, body: v.screenUpdate }), h((r) => svc.updateScreen(b(r), u(r), r.params.id, r.body), 'Screen saved'));
router.post('/screens/:id/pair-code', P('tv.screens'), validate(id), h((r) => svc.newPairCode(b(r), u(r), r.params.id), 'New pairing code'));
router.post('/screens/:id/revoke', P('tv.screens'), validate(id), h((r) => svc.setScreenStatus(b(r), u(r), r.params.id, 'REVOKED'), 'Screen revoked'));
router.post('/screens/:id/disable', P('tv.screens'), validate(id), h((r) => svc.setScreenStatus(b(r), u(r), r.params.id, 'DISABLED'), 'Screen switched off'));
router.post('/screens/:id/enable', P('tv.screens'), validate(id), h((r) => svc.enableScreen(b(r), u(r), r.params.id), 'Screen switched on'));
router.post('/screens/:id/command', P('tv.manage'), validate({ ...id, body: v.commandBody }), h((r) => svc.command(b(r), u(r), r.params.id, r.body), 'Command sent'));
router.post('/screens/:id/announce', P('tv.manage'), validate({ ...id, body: v.announceBody }), h((r) => svc.announce(b(r), u(r), r.params.id, r.body), 'Message sent to the screen'));
router.delete('/screens/:id', P('tv.screens'), validate(id), h((r) => svc.removeScreen(b(r), u(r), r.params.id), 'Screen deleted'));
module.exports = router;
