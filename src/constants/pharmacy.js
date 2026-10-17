/**
 * Country profiles for pharmacy. What a pharmacy must do depends on where it trades, so every country has its own profile:
 * its regulator, the starting medicine classes and the default dispensing rules. A business can override any rule in
 * Business.pharmacySettings. These are STARTING POINTS taken from the published law below; which medicine belongs in which
 * class is decided by the regulator's current lists, not by this software. A registered pharmacist must review the classes and
 * confirm them (POST /pharmacy/settings/confirm-classes) before the pharmacy relies on them.
 *
 *  KE - Pharmacy and Poisons Act (Cap. 244): poisons are Part I (more restricted) or Part II; a Part I poison sold over the counter
 *       without a prescription needs a Poisons Book entry (s.30); dispensed prescriptions go in a Prescription Book (s.31).
 *       Narcotics and psychotropics: Narcotic Drugs and Psychotropic Substances (Control) Act, 1994.
 *  TZ - Pharmacy Act, 2011: prescription medicines only on a prescription (s.39), Prescription Book within 24 hours (s.41),
 *       registrations renew by 31 December (s.22). Prescription regulations: valid 7 days, or 180 days with refills for clinically
 *       stable patients; no refills for controlled drugs; one controlled drug per prescription; the patient or representative
 *       countersigns at dispensing; the pharmacy keeps a serial-numbered dispensing register (date, medicine and batch, patient,
 *       prescriber, facility, prescription number).
 */
const CLASS = (code, label, o = {}) => Object.freeze({ code, label, requiresPrescription: false, dispenserOnly: false, restricted: false, poisonsBook: false, ...o });

const PROFILES = Object.freeze({
  KE: Object.freeze({
    country: 'KE', regulator: 'Pharmacy and Poisons Board (PPB)', registrationLabel: 'PPB registration number', renewalNote: null,
    classes: Object.freeze([
      CLASS('OTC', 'Over the counter (general sale)'),
      CLASS('PHARMACY_ONLY', 'Pharmacy only (Part II poisons / pharmacy medicines)', { dispenserOnly: true }),
      CLASS('PRESCRIPTION_ONLY', 'Prescription only (Part I poisons)', { requiresPrescription: true, dispenserOnly: true }),
      CLASS('PART_I_NO_RX', 'Part I poison supplied without a prescription (Poisons Book entry required)', { dispenserOnly: true, poisonsBook: true }),
      CLASS('CONTROLLED', 'Narcotic / psychotropic (controlled-drugs register)', { requiresPrescription: true, dispenserOnly: true, restricted: true }),
    ]),
    rules: Object.freeze({ prescriptionValidDays: 180, refillValidDays: 180, capValidity: false, noRefillsForRestricted: false, oneRestrictedPerPrescription: false, requireCountersign: false }),
  }),
  TZ: Object.freeze({
    country: 'TZ', regulator: 'Pharmacy Council of Tanzania / TMDA', registrationLabel: 'Pharmacy Council registration number', renewalNote: 'Registrations renew every year by 31 December.',
    classes: Object.freeze([
      CLASS('OTC', 'Over the counter (general sale)'),
      CLASS('PHARMACY_ONLY', 'Pharmacy supplied (no prescription, dispenser only)', { dispenserOnly: true }),
      CLASS('PRESCRIPTION_ONLY', 'Prescription medicine', { requiresPrescription: true, dispenserOnly: true }),
      CLASS('CONTROLLED', 'Narcotic / psychotropic / precursor (controlled drug)', { requiresPrescription: true, dispenserOnly: true, restricted: true }),
    ]),
    rules: Object.freeze({ prescriptionValidDays: 7, refillValidDays: 180, capValidity: true, noRefillsForRestricted: true, oneRestrictedPerPrescription: true, requireCountersign: true }),
  }),
});

const profileFor = (business) => PROFILES[business?.countryCode] || PROFILES.KE;
const defaultClassesFor = (business) => profileFor(business).classes;

/** The rules in force: the country profile, overridden by whatever the business has set. */
function rulesOf(business) {
  const base = profileFor(business).rules; const s = business?.pharmacySettings || {};
  const pick = (k) => (s[k] !== undefined && s[k] !== null ? s[k] : base[k]);
  return { prescriptionValidDays: pick('prescriptionValidDays'), refillValidDays: pick('refillValidDays'), capValidity: base.capValidity, noRefillsForRestricted: pick('noRefillsForRestricted'), oneRestrictedPerPrescription: pick('oneRestrictedPerPrescription'), requireCountersign: pick('requireCountersign') };
}

const CREDENTIAL_ROLES = ['PHARMACIST', 'DISPENSER', 'ASSISTANT'];
const DEFAULT_RANGES = Object.freeze({ room: { minC: 15, maxC: 25 }, fridge: { minC: 2, maxC: 8 } });

module.exports = { PROFILES, profileFor, defaultClassesFor, rulesOf, CREDENTIAL_ROLES, DEFAULT_RANGES, DEFAULT_CLASSES: PROFILES.KE.classes };