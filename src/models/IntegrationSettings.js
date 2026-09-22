const { Schema, model } = require('mongoose');

/**
 * One document per business. This is the ONLY place M-PESA/eTIMS credentials
 * live. `credentialsBlob` is an opaque AES-256-GCM ciphertext (see utils/crypto)
 * - never returned by any controller, never included in AuditLog oldValue/
 * newValue (see integration-settings.service.js, which logs field names
 * changed, never values).
 *
 * Non-secret operational fields (channelId, kraPin, environment, enabled)
 * sit alongside in plaintext because they're needed for routing/UI and
 * aren't sensitive on their own.
 */
const integrationSettingsSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: 'Business', required: true, unique: true, index: true },

    mpesa: {
      enabled: { type: Boolean, default: false },
      provider: { type: String, enum: ['payhero'], default: 'payhero' },
      channelId: { type: String, trim: true }, // PayHero "Payment Channel" id - not secret
      credentialsBlob: { type: String, select: false }, // encrypted { apiUsername, apiPassword }
      credentialsSetAt: { type: Date },
      updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },

    etims: {
      enabled: { type: Boolean, default: false },
      provider: { type: String, enum: ['digitax'], default: 'digitax' },
      environment: { type: String, enum: ['sandbox', 'production'], default: 'sandbox' },
      kraPin: { type: String, trim: true, uppercase: true }, // not secret, already on Business.kraPin too but kept here for eTIMS-specific override
      branchOfficeId: { type: String, trim: true, default: '00' }, // KRA bhfId, per-branch overrides live on Branch if you need >1
      credentialsBlob: { type: String, select: false }, // encrypted { apiKey, username, password } - shape depends on DigiTax's onboarding pack
      credentialsSetAt: { type: Date },
      updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
  },
  { timestamps: true }
);

module.exports = model('IntegrationSettings', integrationSettingsSchema);