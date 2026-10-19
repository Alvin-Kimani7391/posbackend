/** Everything a payment screen needs in ONE call (restaurant bill dialog + room folio dialog). */
const integrationSettings = require('./integration-settings.service');
const shiftService = require('./shift.service');
const registerService = require('./register.service');
const CashShift = require('../models/CashShift');
const ApiError = require('../utils/ApiError');
const NETWORKS = {
  KE: [['SAFARICOM', 'Safaricom M-PESA'], ['AIRTEL', 'Airtel Money'], ['TKASH', 'T-Kash (Telkom)'], ['OTHER', 'Other']],
  TZ: [['VODACOM', 'Vodacom M-Pesa'], ['MIXX', 'Mixx by Yas (Tigo Pesa)'], ['AIRTEL', 'Airtel Money'], ['HALOPESA', 'HaloPesa'], ['AZAMPESA', 'Azam Pesa'], ['OTHER', 'Other']],
  DEFAULT: [['MPESA', 'M-Pesa'], ['AIRTEL', 'Airtel Money'], ['OTHER', 'Other']],
};
async function build({ businessId, branchId, user, ctx }) {
  const [flags, shift, registers] = await Promise.all([
    integrationSettings.getFlagsForPos(businessId),
    shiftService.getCurrentShift(businessId, branchId, user._id),
    registerService.listRegisters(businessId, branchId),
  ]);
  const b = ctx.business;
  const requireShift = !!(ctx.settings.paymentsRequireShift && b.settings?.requireShift !== false);
  const country = b.countryCode || 'KE';
  return {
    flags: { mpesaStk: !!flags.mpesaEnabled && country === 'KE', mpesaTill: !!flags.mpesaManualEnabled && country === 'KE', tillNumber: flags.tillNumber || null },
    requireShift, shift: shift || null,
    registers: registers.filter((r) => r.status === 'active'),
    networks: (NETWORKS[country] || NETWORKS.DEFAULT).map(([code, label]) => ({ code, label })),
    currency: b.currency || 'KES',
    business: { name: b.name, phone: b.phone, address: b.address, pin: b.kraPin || b.taxPin || b.vrn || null, logo: b.logo || null },
  };
}
async function openShift({ businessId, user, branchId, registerId, openingCash }) {
  const existing = await CashShift.findOne({ businessId, cashierId: user._id, status: 'OPEN' });
  if (existing) throw ApiError.conflict('You already have an open shift', 'SHIFT_ALREADY_OPEN');
  return shiftService.openShift(businessId, branchId, user._id, { registerId, openingCash });
}
module.exports = { build, openShift, NETWORKS };
