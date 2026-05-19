const { verifyToken } = require("../auth/auth");
const { readStore } = require("../store/store");

function extractToken(req) {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice(7);
}

async function authRequired(req) {
  const token = extractToken(req);
  if (!token) {
    throw Object.assign(new Error("未提供认证令牌"), { statusCode: 401, code: "AUTH_REQUIRED" });
  }

  const result = verifyToken(token);
  if (!result) {
    throw Object.assign(new Error("令牌无效"), { statusCode: 401, code: "TOKEN_INVALID" });
  }

  if (result.expired) {
    throw Object.assign(new Error("令牌已过期"), { statusCode: 401, code: "TOKEN_EXPIRED" });
  }

  if (result.type !== "access") {
    throw Object.assign(new Error("令牌类型错误"), { statusCode: 401, code: "TOKEN_INVALID" });
  }

  const store = readStore();
  const user = store.users.find(u => u.id === result.sub);
  if (!user) {
    throw Object.assign(new Error("用户不存在"), { statusCode: 404, code: "USER_NOT_FOUND" });
  }

  if (user.status === "disabled") {
    throw Object.assign(new Error("账号已被禁用"), { statusCode: 403, code: "USER_DISABLED" });
  }

  if (user.token_version !== result.token_version) {
    throw Object.assign(new Error("令牌已失效，请重新登录"), { statusCode: 401, code: "TOKEN_INVALID" });
  }

  return { user, tenantId: user.tenant_id };
}

async function adminRequired(req) {
  const auth = await authRequired(req);
  if (auth.user.role !== "admin") {
    throw Object.assign(new Error("权限不足"), { statusCode: 403, code: "FORBIDDEN" });
  }
  return auth;
}

module.exports = { authRequired, adminRequired, extractToken };
