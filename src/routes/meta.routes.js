const router = require('express').Router();
const { sendSuccess } = require('../utils/ApiResponse');
const { describeCountries, LANGUAGES } = require('../constants/countries');

/**
 * PUBLIC (no login): feeds the onboarding screen where the owner picks Kenya or Tanzania.
 * Each country carries its currency, default language, VAT rate, tax-id label, the notes/coins counted
 * at shift close, mobile-money options and which integrations exist - so the app never hard-codes them.
 */
router.get('/countries', (req, res) => sendSuccess(res, 200, 'Countries fetched', { countries: describeCountries(), languages: LANGUAGES }));

module.exports = router;
