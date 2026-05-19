const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const BCRYPT_ROUNDS = 10;

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET 未配置");
  return secret;
}

function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

function generateTempPassword() {
  return crypto.randomBytes(8).toString("hex");
}

function createAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tenant_id: user.tenant_id,
      email: user.email,
      role: user.role,
      token_version: user.token_version || 1,
      type: "access"
    },
    getSecret(),
    {
      expiresIn: "15m",
      jwtid: crypto.randomBytes(8).toString("hex")
    }
  );
}

function createRefreshToken(user, rememberMe) {
  return jwt.sign(
    {
      sub: user.id,
      tenant_id: user.tenant_id,
      email: user.email,
      role: user.role,
      token_version: user.token_version || 1,
      type: "refresh"
    },
    getSecret(),
    {
      expiresIn: rememberMe ? "30d" : "7d",
      jwtid: crypto.randomBytes(8).toString("hex")
    }
  );
}

function verifyToken(token) {
  try {
    const payload = jwt.verify(token, getSecret());
    return payload;
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      const decoded = jwt.decode(token);
      return { expired: true, payload: decoded };
    }
    return null;
  }
}

function serializeUser(user) {
  return {
    id: user.id,
    tenant_id: user.tenant_id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    credit_balance: user.credit_balance,
    last_login_at: user.last_login_at || null,
    created_at: user.created_at,
    updated_at: user.updated_at
  };
}

function generateJwtSecret() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = {
  hashPassword,
  verifyPassword,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  generateTempPassword,
  serializeUser,
  generateJwtSecret,
  getSecret
};
