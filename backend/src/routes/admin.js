const { updateStore, readStore, id, now, findUserByEmail, countAdmins } = require("../store/store");
const { hashPassword, generateTempPassword, serializeUser } = require("../auth/auth");
const { adminRequired } = require("../middleware/auth");

async function listUsers(req, res, send) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const search = url.searchParams.get("search") || "";
  const role = url.searchParams.get("role") || "";
  const status = url.searchParams.get("status") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size")) || 20));

  const store = readStore();
  let users = [...(store.users || [])];

  if (search) {
    const q = search.toLowerCase();
    users = users.filter(u =>
      (u.email && u.email.toLowerCase().includes(q)) ||
      (u.name && u.name.toLowerCase().includes(q))
    );
  }
  if (role) users = users.filter(u => u.role === role);
  if (status) users = users.filter(u => u.status === status);

  const total = users.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const start = (page - 1) * pageSize;
  const paged = users.slice(start, start + pageSize).map(serializeUser);

  send(res, 200, { data: { users: paged, total, page, page_size: pageSize, total_pages: totalPages } });
}

async function createUser(req, res, send, body) {
  const { email, name, role: reqRole, credit_balance } = body;
  if (!email || !name) {
    send(res, 422, { error: "VALIDATION_ERROR", message: "邮箱和姓名为必填项。" });
    return;
  }

  const password = generateTempPassword();
  const hashVal = await hashPassword(password);

  const result = await updateStore(store => {
    const existing = findUserByEmail(store, email);
    if (existing) return { error: { status: 409, code: "EMAIL_ALREADY_EXISTS", message: "该邮箱已被使用。" } };

    const nowStr = now();

    const user = {
      id: id("user"),
      tenant_id: "tenant-demo",
      email,
      name,
      password_hash: hashVal,
      role: reqRole || "operator",
      status: "active",
      credit_balance: typeof credit_balance === "number" ? credit_balance : 500,
      token_version: 1,
      last_login_at: null,
      created_at: nowStr,
      updated_at: nowStr
    };

    store.users.push(user);

    store.admin_audit_logs.push({
      id: id("audit"),
      tenant_id: "tenant-demo",
      admin_user_id: req.userId,
      action: "user_created",
      target_user_id: user.id,
      detail: { email, name, role: user.role, credit_balance: user.credit_balance },
      created_at: nowStr
    });

    return { user: serializeUser(user), password };
  });

  if (result.error) { send(res, result.error.status, { error: result.error.code, message: result.error.message }); return; }
  send(res, 201, { data: result });
}

async function updateUser(req, res, send, body) {
  const userId = req.userId;
  const targetId = body.target_id;

  const result = await updateStore(store => {
    const user = store.users.find(u => u.id === targetId);
    if (!user) return { error: { status: 404, code: "USER_NOT_FOUND", message: "用户不存在。" } };

    const changedFields = [];

    if (body.name !== undefined && body.name !== user.name) {
      user.name = body.name;
      changedFields.push("name");
    }
    if (body.role !== undefined && body.role !== user.role) {
      if (body.role !== "admin" && user.role === "admin" && countAdmins(store) <= 1) {
        return { error: { status: 422, code: "CANNOT_DEMOTE_LAST_ADMIN", message: "不能取消最后一个管理员的 admin 角色。" } };
      }
      user.role = body.role;
      changedFields.push("role");
    }
    if (body.status !== undefined && body.status !== user.status) {
      if (body.status === "disabled" && user.id === userId) {
        return { error: { status: 422, code: "CANNOT_DISABLE_SELF", message: "不能禁用自己的账号。" } };
      }
      const prevStatus = user.status;
      user.status = body.status;
      changedFields.push("status");
      if (body.status === "disabled" && prevStatus === "active") {
        user.token_version = (user.token_version || 1) + 1;
      }
    }
    if (typeof body.credit_balance === "number" && body.credit_balance !== user.credit_balance) {
      user.credit_balance = body.credit_balance;
      changedFields.push("credit_balance");
    }
    user.updated_at = now();

    const actionType = body.status === "disabled" ? "user_disabled" :
                       (body.status === "active" && changedFields.includes("status")) ? "user_enabled" :
                       "user_updated";

    store.admin_audit_logs.push({
      id: id("audit"),
      tenant_id: "tenant-demo",
      admin_user_id: userId,
      action: actionType,
      target_user_id: targetId,
      detail: { changed_fields: changedFields },
      created_at: now()
    });

    return { user: serializeUser(user) };
  });

  if (result.error) { send(res, result.error.status, { error: result.error.code, message: result.error.message }); return; }
  send(res, 200, { data: result });
}

async function disableUser(req, res, send) {
  const userId = req.userId;
  const targetId = req.params.targetId;

  const result = await updateStore(store => {
    const user = store.users.find(u => u.id === targetId);
    if (!user) return { error: { status: 404, code: "USER_NOT_FOUND", message: "用户不存在。" } };
    if (user.id === userId) return { error: { status: 422, code: "CANNOT_DISABLE_SELF", message: "不能禁用自己的账号。" } };
    if (user.role === "admin" && countAdmins(store) <= 1) {
      return { error: { status: 422, code: "CANNOT_DEMOTE_LAST_ADMIN", message: "不能禁用最后一个管理员。" } };
    }

    user.status = "disabled";
    user.token_version = (user.token_version || 1) + 1;
    user.updated_at = now();

    store.admin_audit_logs.push({
      id: id("audit"),
      tenant_id: "tenant-demo",
      admin_user_id: userId,
      action: "user_disabled",
      target_user_id: targetId,
      detail: {},
      created_at: now()
    });

    return { user: serializeUser(user) };
  });

  if (result.error) { send(res, result.error.status, { error: result.error.code, message: result.error.message }); return; }
  send(res, 200, { data: result });
}

async function resetUserPassword(req, res, send, body) {
  const userId = req.userId;
  const targetId = body.target_id;

  const newPassword = body.new_password || generateTempPassword();
  const newHash = await hashPassword(newPassword);

  const result = await updateStore(store => {
    const user = store.users.find(u => u.id === targetId);
    if (!user) return { error: { status: 404, code: "USER_NOT_FOUND", message: "用户不存在。" } };

    user.password_hash = newHash;
    user.token_version = (user.token_version || 1) + 1;
    user.updated_at = now();

    store.admin_audit_logs.push({
      id: id("audit"),
      tenant_id: "tenant-demo",
      admin_user_id: userId,
      action: "user_password_reset",
      target_user_id: targetId,
      detail: {},
      created_at: now()
    });

    return { user: serializeUser(user), password: newPassword };
  });

  if (result.error) { send(res, result.error.status, { error: result.error.code, message: result.error.message }); return; }
  send(res, 200, { data: result });
}

async function listAuditLogs(req, res, send) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("page_size")) || 50));

  const store = readStore();
  const logs = [...(store.admin_audit_logs || [])].reverse();

  const total = logs.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const start = (page - 1) * pageSize;
  const paged = logs.slice(start, start + pageSize);

  send(res, 200, { data: { logs: paged, total, page, page_size: pageSize, total_pages: totalPages } });
}

module.exports = { listUsers, createUser, updateUser, disableUser, resetUserPassword, listAuditLogs };
