const jwt = require('jsonwebtoken');
const { jwt: jwtConfig } = require('../config/env');

// SUPER_ADMIN users belong to no business, so businessId may be undefined.
const bizId = (user) => (user.businessId ? user.businessId.toString() : undefined);

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      businessId: bizId(user),
      role: user.role,
    },
    jwtConfig.secret,
    { expiresIn: jwtConfig.expiresIn }
  );
}

function signRefreshToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      businessId: bizId(user),
      tokenVersion: user.refreshTokenVersion,
    },
    jwtConfig.refreshSecret,
    { expiresIn: jwtConfig.refreshExpiresIn }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, jwtConfig.secret);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, jwtConfig.refreshSecret);
}

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken };