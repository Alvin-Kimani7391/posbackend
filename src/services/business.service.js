const Business = require('../models/Business');
const AuditLog = require('../models/AuditLog');
const ApiError = require('../utils/ApiError');

// Fields an ADMIN/OWNER may edit. Never allow status/subscription fields to be
// set from this route - those are controlled by billing/admin processes.
const EDITABLE_FIELDS = [
  'name', 'legalName', 'businessType', 'phone', 'email', 'address', 'county', 'town',
  'taxPin', 'kraPin', 'vatRegistered', 'currency', 'timezone', 'logo',
  'receiptSettings', 'taxSettings', 'paymentSettings', 'settings',
];

// These fields are nested objects on the Business schema (sub-documents),
// not scalars. A caller is allowed to send just the one or two keys they
// actually changed (e.g. { settings: { enableCustomerCredit: true } }), so
// we MERGE into the existing sub-object instead of overwriting it wholesale.
// Overwriting would silently blank out every sibling setting the caller
// didn't mention (requireShift, allowNegativeStock, maxCashierDiscountPercent...).
const NESTED_OBJECT_FIELDS = ['receiptSettings', 'taxSettings', 'paymentSettings', 'settings'];

async function getOwnBusiness(businessId) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');
  return business;
}

async function updateOwnBusiness(businessId, userId, updates) {
  const business = await Business.findById(businessId);
  if (!business) throw ApiError.notFound('Business not found');

  const oldValue = business.toObject();

  for (const field of EDITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(updates, field)) continue;

    if (NESTED_OBJECT_FIELDS.includes(field)) {
      // Merge, don't replace - see NESTED_OBJECT_FIELDS comment above.
      Object.assign(business[field], updates[field]);
      business.markModified(field);
    } else {
      business[field] = updates[field];
    }
  }

  await business.save();

  await AuditLog.create({
    businessId,
    userId,
    action: 'business.update',
    entityType: 'Business',
    entityId: business._id,
    oldValue,
    newValue: business.toObject(),
  });

  return business;
}

module.exports = { getOwnBusiness, updateOwnBusiness };