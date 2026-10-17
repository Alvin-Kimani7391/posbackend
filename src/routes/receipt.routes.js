const router = require('express').Router();
const controller = require('../controllers/receipt.controller');
const validate = require('../middleware/validate');
const { authenticate } = require('../middleware/auth');
const { receiptVerifyLimiter } = require('../middleware/rateLimiters');
const { verifyReceiptSchema } = require('../validators/receipt.validator');

router.use(authenticate);
// No granular permission on purpose: every employee at the door (cashier, guard, storekeeper) must be able to check a receipt.
router.post('/verify', receiptVerifyLimiter, validate({ body: verifyReceiptSchema }), controller.verify);

module.exports = router;
