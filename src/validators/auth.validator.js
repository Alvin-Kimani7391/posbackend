const { z } = require('zod');
const { kenyanPhone } = require('./common');

const registerSchema = z.object({
  businessName: z.string().trim().min(2),
  ownerName: z.string().trim().min(2),
  phone: kenyanPhone,
  email: z.string().trim().email().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

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
};
