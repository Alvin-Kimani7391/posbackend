const { z } = require('zod');
const { isValidPhone } = require('../utils/phone');
const { COUNTRY_CODES, LANGUAGES, toCountryCode, DEFAULT_COUNTRY } = require('../constants/countries');
const { BUSINESS_TYPES } = require('../constants/businessFeatures');

// Onboarding: the owner chooses the country first ('KE' | 'TZ', also 'Kenya' / 'Tanzania'). Defaults to Kenya so
// existing Kenyan clients that do not send a country keep working unchanged.
const countryInput = z.preprocess(
  (v) => (v === undefined || v === null || v === '' ? DEFAULT_COUNTRY : toCountryCode(v) || v),
  z.enum(COUNTRY_CODES, { errorMap: () => ({ message: 'Choose Kenya or Tanzania' }) })
);

const registerSchema = z
  .object({
    businessName: z.string().trim().min(2),
    businessType: z.enum(BUSINESS_TYPES).optional(), // defaults to general_shop
    country: countryInput,
    language: z.enum(LANGUAGES).optional(), // defaults: Kenya -> en, Tanzania -> sw
    ownerName: z.string().trim().min(2),
    phone: z.string().trim(),
    email: z.string().trim().email().optional(),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  })
  .superRefine((d, ctx) => {
    if (!isValidPhone(d.phone, d.country)) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: d.country === 'TZ' ? 'Invalid Tanzanian phone number' : 'Invalid Kenyan phone number' });
    }
  });

const languageSchema = z.object({ language: z.enum(LANGUAGES) }).strict();

const loginSchema = z.object({
  identifier: z.string().trim().min(3), // email or phone
  password: z.string().min(1),
});

const pinLoginSchema = z.object({
  businessId: z.string(),
  employeeCode: z.string().trim(),
  pin: z.string().min(4).max(8),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
});

const resetPasswordSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

module.exports = {
  registerSchema,
  loginSchema,
  pinLoginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  languageSchema,
};