/** Shared plumbing for guest ordering and accommodation. Builds on the restaurant services' transaction / audit / access helpers. */
const AccommodationSettings = require('../../models/AccommodationSettings');
const User = require('../../models/User');
const ApiError = require('../../utils/ApiError');
const { ROLES } = require('../../constants/roles');
const C = require('../restaurant/common');

/** Accommodation settings (created with defaults on first use) + the facts every stay calculation needs. */
async function getAccContext(businessId, session) {
  const base = await C.getContext(businessId, session);
  let acc = await C.withSession(AccommodationSettings.findOne({ businessId }), session);
  if (!acc) {
    try { [acc] = await AccommodationSettings.create([{ businessId }], session ? { session } : {}); } catch (e) { if (e.code !== 11000) throw e; acc = await C.withSession(AccommodationSettings.findOne({ businessId }), session); }
  }
  const roomTaxRate = acc.tax?.roomTaxRate ?? base.defaultTaxRate;
  return { ...base, acc, roomTaxRate };
}

function assertAccommodation(ctx) {
  if (!ctx.features.accommodation) throw ApiError.forbidden('Accommodation is not enabled for this business', 'FEATURE_DISABLED');
}

/**
 * Orders that start from a guest's phone have no staff member. They are recorded against the business owner's account
 * (so every permission check inside the order code passes) but carry source QR_TABLE / QR_ROOM and the name "Guest (QR)".
 */
async function guestActor(businessId) {
  const owner = await User.findOne({ businessId, role: ROLES.OWNER, status: 'active' }).select('_id name role branchIds').lean();
  if (!owner) throw ApiError.badRequest('This business has no active owner account', 'NO_OWNER');
  return { _id: owner._id, name: 'Guest (QR)', role: ROLES.OWNER, businessId, branchIds: owner.branchIds || [], revokedPermissions: [], grantedPermissions: [], isGuestActor: true };
}

const rand = (n, alphabet) => { const crypto = require('crypto'); let s = ''; for (let i = 0; i < n; i += 1) s += alphabet[crypto.randomInt(alphabet.length)]; return s; };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I: easy to read aloud

module.exports = { ...C, getAccContext, assertAccommodation, guestActor, rand, CODE_ALPHABET };
