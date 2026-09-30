/**
 * One-off: creates the platform SUPER_ADMIN (nobody can self-register into this role).
 *
 *   ADMIN_NAME="Your Name" ADMIN_EMAIL=you@domain.com ADMIN_PHONE=0712345678 \
 *   ADMIN_PASSWORD='a-long-password' node scripts/create-super-admin.js
 *
 * Log in on admin-login.html with the EMAIL (email lookups are lower-cased).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');
const { ROLES } = require('../src/constants/roles');

(async () => {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.DATABASE_URL;
  if (!uri) throw new Error('Set MONGODB_URI (or MONGO_URI / DATABASE_URL) in your environment');
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PHONE || !ADMIN_PASSWORD) throw new Error('ADMIN_NAME, ADMIN_EMAIL, ADMIN_PHONE and ADMIN_PASSWORD are required');
  if (ADMIN_PASSWORD.length < 12) throw new Error('Use a password of at least 12 characters');

  await mongoose.connect(uri);
  const email = ADMIN_EMAIL.toLowerCase().trim();
  const existing = await User.findOne({ email, role: ROLES.SUPER_ADMIN });
  if (existing) { console.log('Super admin already exists:', existing._id.toString()); return; }

  const user = await User.create({
    name: ADMIN_NAME, email, phone: ADMIN_PHONE.trim(),
    passwordHash: await User.hashSecret(ADMIN_PASSWORD),
    role: ROLES.SUPER_ADMIN, status: 'active', // no businessId on purpose
  });
  console.log('Super admin created:', user._id.toString());
})()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());