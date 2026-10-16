const router = require('express').Router();
const controller = require('../controllers/business.controller');
const validate = require('../middleware/validate');
const { authenticate, requirePermission, authorizeRole } = require('../middleware/auth');
const { ROLES } = require('../constants/roles');
const { updateBusinessSchema, updateOnboardingSchema, countrySchema } = require('../validators/business.validator');

router.use(authenticate);

// Open to EVERY signed-in role: the menu is personalised from this (a cashier has no settings.view).
// Static paths first so they are never read as ids.
router.get('/profile', controller.getProfile);
router.get('/types', controller.getTypes);

// Setup guide: owner-level (settings.*) because it is about configuring the business.
router.get('/onboarding', requirePermission('settings.view'), controller.getOnboarding);
router.put('/onboarding', requirePermission('settings.update'), validate({ body: updateOnboardingSchema }), controller.updateOnboarding);

// Only the owner may re-pick the country, and only before any money data exists.
router.put('/country', authorizeRole(ROLES.OWNER), requirePermission('settings.update'), validate({ body: countrySchema }), controller.changeCountry);

router.get('/', requirePermission('settings.view'), controller.getBusiness);
router.put('/', requirePermission('settings.update'), validate({ body: updateBusinessSchema }), controller.updateBusiness);

module.exports = router;
