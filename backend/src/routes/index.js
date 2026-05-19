// HTTP route handlers
// Called by: server.js
// Depends on: store, all services, model-gateway, oss

const fs = require("fs");
const path = require("path");
const { readStore, writeStore, updateStore, id, now, modelLibrary, findModelById, normalizeModelPayload, addEvent, findUserByEmail } = require("../store/store");
const { inferGarment, normalizeGarmentCategory, riskFromFile, isRemoteUrl, normalizeGarmentReferenceImages, normalizeUploadedFile, saveDataUrlToLocal, MAX_GARMENT_REFERENCE_IMAGES } = require("../services/garment");
const { validateAliyunTryonInputs, validateFashnTryonInputs } = require("../services/validation");
const { recommendParams, creditCost, apiCapabilities } = require("../services/agent");
const { scheduleTask, svgForResult } = require("../services/task-runner");
const { classifyGarmentImage } = require("../ai/model-gateway");
const { hashPassword, verifyPassword, createAccessToken, createRefreshToken, verifyToken, serializeUser } = require("../auth/auth");
const { authRequired, adminRequired } = require("../middleware/auth");
const adminRoutes = require("./admin");
const { checkRateLimit, recordRateLimit } = require("../rate-limiter");
const oss = require("../storage/oss");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const MAX_JSON_BODY_BYTES = 35 * 1024 * 1024;

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    ...headers
  });
  res.end(body);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, { error: "NOT_FOUND", message: "接口不存在" });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > MAX_JSON_BODY_BYTES) {
        reject(new Error("请求体过大。单张图片最大支持 20MB；如果提交任务时报错，请减少细节参考图数量或确认前端没有提交本地预览图内容。"));
      }
    });
    req.on("end", () => {
      if (!data) { resolve({}); return; }
      try { resolve(JSON.parse(data)); } catch (error) { reject(new Error("JSON 格式错误")); }
    });
  });
}

// ── v2.0: Public route whitelist ──

const PUBLIC_ROUTES = [
  { method: "GET", pattern: /^\/health$/ },
  { method: "GET", pattern: /^\/v1\/system\/capabilities$/ },
  { method: "POST", pattern: /^\/v1\/auth\/login$/ },
  { method: "POST", pattern: /^\/v1\/auth\/refresh$/ },
  { method: "GET", pattern: /^\/v1\/media\/uploads\// },
  { method: "GET", pattern: /^\/v1\/media\/models\// },
  { method: "GET", pattern: /^\/v1\/media\/generated\// },
  { method: "GET", pattern: /^\/v1\/media\/results\// }
];

function isPublicRoute(method, pathname) {
  return PUBLIC_ROUTES.some(r => r.method === method && r.pattern.test(pathname));
}

function getCurrentUser(store, userId) {
  return store.users.find(u => u.id === userId);
}

async function route(req, res) {
  if (req.method === "OPTIONS") { send(res, 204, {}); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // ── v2.0: Auth middleware injection ──

  if (!isPublicRoute(req.method, pathname)) {
    try {
      const auth = await authRequired(req);
      req.userId = auth.user.id;
      req.tenantId = auth.user.tenant_id;
      req.userRole = auth.user.role;
    } catch (err) {
      send(res, err.statusCode || 401, { error: err.code || "AUTH_REQUIRED", message: err.message });
      return;
    }
  }

  // ── Health & capabilities (public) ──

  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, { status: "ok", service: "virtual-tryon-backend", time: now() });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/system/capabilities") {
    send(res, 200, { data: apiCapabilities() });
    return;
  }

  // ── v2.0: Auth endpoints ──

  if (req.method === "POST" && pathname === "/v1/auth/login") {
    const body = await parseBody(req);
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";

    const limit = checkRateLimit(ip, body.email);
    if (limit.limited) {
      send(res, 429, { error: "LOGIN_RATE_LIMITED", message: `登录尝试次数过多，请 ${limit.retryAfter} 秒后再试。` }, { "Retry-After": String(limit.retryAfter) });
      return;
    }

    const store = readStore();
    const user = findUserByEmail(store, body.email);

    // Unified error to prevent user enumeration
    if (!user || user.status === "disabled") {
      recordRateLimit(ip, body.email);
      send(res, 401, { error: "AUTH_REQUIRED", message: "邮箱或密码错误" });
      return;
    }

    // Clean expired lockout entries
    const lockout = store.login_lockouts && store.login_lockouts[user.id];
    if (lockout && lockout.locked_until) {
      if (new Date(lockout.locked_until) <= new Date()) {
        delete store.login_lockouts[user.id];
      }
    }

    const effectiveLockout = store.login_lockouts && store.login_lockouts[user.id];
    if (effectiveLockout && effectiveLockout.locked_until > now()) {
      send(res, 429, { error: "LOGIN_RATE_LIMITED", message: "账号已被临时锁定，请 15 分钟后再试。" });
      return;
    }

    const pwdOk = await verifyPassword(body.password, user.password_hash);
    if (!pwdOk) {
      recordRateLimit(ip, body.email);
      const prevFailed = (effectiveLockout && effectiveLockout.failed_count) || 0;
      const newFailedCount = prevFailed + 1;
      const remaining = Math.max(0, 5 - newFailedCount);
      await updateStore(s => {
        if (!s.login_lockouts) s.login_lockouts = {};
        const entry = s.login_lockouts[user.id] || { failed_count: 0 };
        entry.failed_count = newFailedCount;
        if (entry.failed_count >= 5) {
          entry.locked_until = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        }
        s.login_lockouts[user.id] = entry;
      });
      send(res, 401, { error: "AUTH_REQUIRED", message: "邮箱或密码错误", remaining_attempts: remaining });
      return;
    }

    await updateStore(s => {
      if (s.login_lockouts && s.login_lockouts[user.id]) {
        delete s.login_lockouts[user.id];
      }
      const u = s.users.find(x => x.id === user.id);
      if (u) u.last_login_at = now();
    });

    const rememberMe = Boolean(body.remember_me);
    const accessToken = createAccessToken(user);
    const refreshToken = createRefreshToken(user, rememberMe);

    send(res, 200, {
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user: serializeUser(user)
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/auth/refresh") {
    const body = await parseBody(req);
    const refreshToken = body.refresh_token;
    if (!refreshToken) {
      send(res, 401, { error: "REFRESH_TOKEN_INVALID", message: "缺少 refresh_token。" });
      return;
    }

    const result = verifyToken(refreshToken);
    if (!result || result.expired) {
      send(res, 401, { error: "REFRESH_TOKEN_INVALID", message: "refresh_token 无效或已过期。" });
      return;
    }
    if (result.type !== "refresh") {
      send(res, 401, { error: "REFRESH_TOKEN_INVALID", message: "令牌类型错误。" });
      return;
    }

    const store = readStore();
    const blacklisted = (store.refresh_token_blacklist || []).find(e => e.jti === result.jti);
    if (blacklisted) {
      send(res, 401, { error: "REFRESH_TOKEN_INVALID", message: "refresh_token 已被吊销。" });
      return;
    }

    const user = store.users.find(u => u.id === result.sub);
    if (!user || user.status === "disabled" || user.token_version !== result.token_version) {
      send(res, 401, { error: "REFRESH_TOKEN_INVALID", message: "令牌已失效，请重新登录。" });
      return;
    }

    await updateStore(s => {
      s.refresh_token_blacklist = s.refresh_token_blacklist || [];
      s.refresh_token_blacklist.push({
        jti: result.jti,
        user_id: user.id,
        expires_at: new Date(result.exp * 1000).toISOString()
      });
    });

    const newAccessToken = createAccessToken(user);
    const newRefreshToken = createRefreshToken(user, false);

    send(res, 200, {
      data: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/auth/logout") {
    const body = await parseBody(req).catch(() => ({}));
    const token = body.refresh_token;
    if (token) {
      const result = verifyToken(token);
      if (result && !result.expired && result.jti) {
        await updateStore(s => {
          s.refresh_token_blacklist = s.refresh_token_blacklist || [];
          s.refresh_token_blacklist.push({
            jti: result.jti,
            user_id: result.sub,
            expires_at: new Date(result.exp * 1000).toISOString()
          });
        });
      }
    }
    send(res, 200, { data: { message: "已登出" } });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/auth/me") {
    const store = readStore();
    const user = getCurrentUser(store, req.userId);
    if (!user) { send(res, 404, { error: "USER_NOT_FOUND", message: "用户不存在。" }); return; }
    send(res, 200, { data: serializeUser(user) });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/auth/change-password") {
    const body = await parseBody(req);
    const store = readStore();
    const user = getCurrentUser(store, req.userId);
    if (!user) { send(res, 404, { error: "USER_NOT_FOUND", message: "用户不存在。" }); return; }

    const pwdOk = await verifyPassword(body.old_password, user.password_hash);
    if (!pwdOk) {
      send(res, 422, { error: "OLD_PASSWORD_WRONG", message: "旧密码错误" });
      return;
    }

    if (!body.new_password || body.new_password.length < 6) {
      send(res, 422, { error: "VALIDATION_ERROR", message: "新密码长度不少于6位。" });
      return;
    }

    const newHash = await hashPassword(body.new_password);
    await updateStore(s => {
      const u = s.users.find(x => x.id === req.userId);
      if (!u) return;
      u.password_hash = newHash;
      u.token_version = (u.token_version || 1) + 1;
      u.updated_at = now();
    });

    send(res, 200, { data: { message: "密码已修改，请使用新密码重新登录。" } });
    return;
  }

  // ── v2.0: Admin endpoints ──

  if (req.method === "GET" && pathname === "/v1/admin/users") {
    try {
      await adminRequired(req);
      await adminRoutes.listUsers(req, res, send);
    } catch (err) {
      send(res, err.statusCode || 403, { error: err.code || "FORBIDDEN", message: err.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/admin/users") {
    try {
      await adminRequired(req);
      const body = await parseBody(req);
      await adminRoutes.createUser(req, res, send, body);
    } catch (err) {
      send(res, err.statusCode || 403, { error: err.code || "FORBIDDEN", message: err.message });
    }
    return;
  }

  const adminUserUpdate = pathname.match(/^\/v1\/admin\/users\/([^/]+)$/);
  if (req.method === "PUT" && adminUserUpdate) {
    try {
      await adminRequired(req);
      const body = await parseBody(req);
      body.target_id = adminUserUpdate[1];
      await adminRoutes.updateUser(req, res, send, body);
    } catch (err) {
      send(res, err.statusCode || 403, { error: err.code || "FORBIDDEN", message: err.message });
    }
    return;
  }

  if (req.method === "DELETE" && adminUserUpdate) {
    try {
      await adminRequired(req);
      req.params = { targetId: adminUserUpdate[1] };
      await adminRoutes.disableUser(req, res, send);
    } catch (err) {
      send(res, err.statusCode || 403, { error: err.code || "FORBIDDEN", message: err.message });
    }
    return;
  }

  const adminPwdReset = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/reset-password$/);
  if (req.method === "POST" && adminPwdReset) {
    try {
      await adminRequired(req);
      const body = await parseBody(req);
      body.target_id = adminPwdReset[1];
      await adminRoutes.resetUserPassword(req, res, send, body);
    } catch (err) {
      send(res, err.statusCode || 403, { error: err.code || "FORBIDDEN", message: err.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/v1/admin/audit-logs") {
    try {
      await adminRequired(req);
      await adminRoutes.listAuditLogs(req, res, send);
    } catch (err) {
      send(res, err.statusCode || 403, { error: err.code || "FORBIDDEN", message: err.message });
    }
    return;
  }

  // ── Models ──

  if (req.method === "GET" && pathname === "/v1/models/system") {
    const store = readStore();
    send(res, 200, { data: modelLibrary(store) });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/models/system") {
    const body = await parseBody(req);
    body.file = await normalizeUploadedFile(body.file, "models");
    const fileUrl = body.file?.url || body.file?.read_url || body.file?.data_url || body.file_url || null;
    if (!fileUrl) {
      send(res, 422, { error: "MODEL_IMAGE_REQUIRED", message: "新增模特需要上传真人/模特图片。" });
      return;
    }
    const model = await updateStore(store => {
      const risk_flags = riskFromFile({ ...(body.file || {}), expected_role: "model" });
      const entry = {
        id: id("model"), tenant_id: req.tenantId, user_id: req.userId, source: "library_upload",
        ...normalizeModelPayload({ ...body, file_url: fileUrl, preview_url: fileUrl }),
        file_url: fileUrl, preview_url: fileUrl,
        size_bytes: Number(body.file?.size || 0), mime_type: body.file?.type || null,
        object_key: body.file?.object_key || null, risk_flags,
        created_at: now(), updated_at: now()
      };
      store.model_assets.push(entry);
      return entry;
    });
    send(res, 201, { data: model });
    return;
  }

  const modelCrudMatch = pathname.match(/^\/v1\/models\/system\/([^/]+)$/);
  if (modelCrudMatch && req.method === "PUT") {
    const modelId = decodeURIComponent(modelCrudMatch[1]);
    const body = await parseBody(req);
    body.file = await normalizeUploadedFile(body.file, "models");
    const updatedModel = await updateStore(store => {
      const existing = findModelById(store, modelId);
      if (!existing) return null;
      const fileUrl = body.file?.url || body.file?.read_url || body.file?.data_url || body.file_url || existing.file_url || null;
      const fields = normalizeModelPayload({ ...body, file_url: fileUrl, preview_url: fileUrl }, existing);
      if (existing.source === "system") {
        const previous = store.model_library_changes.find(item => item.id === modelId);
        if (previous) { previous.deleted = false; previous.fields = fields; previous.updated_at = now(); }
        else { store.model_library_changes.push({ id: modelId, deleted: false, fields, updated_at: now() }); }
      } else {
        const index = store.model_assets.findIndex(item => item.id === modelId);
        if (index === -1) return null;
        store.model_assets[index] = {
          ...store.model_assets[index], ...fields,
          file_url: fileUrl, preview_url: fileUrl,
          size_bytes: Number(body.file?.size || store.model_assets[index].size_bytes || 0),
          mime_type: body.file?.type || store.model_assets[index].mime_type || null,
          object_key: body.file?.object_key || store.model_assets[index].object_key || null,
          risk_flags: body.file ? riskFromFile({ ...body.file, expected_role: "model" }) : store.model_assets[index].risk_flags || [],
          updated_at: now()
        };
      }
      return findModelById(store, modelId);
    });
    if (!updatedModel) return notFound(res);
    send(res, 200, { data: updatedModel });
    return;
  }

  if (modelCrudMatch && req.method === "DELETE") {
    const modelId = decodeURIComponent(modelCrudMatch[1]);
    const result = await updateStore(store => {
      const existing = findModelById(store, modelId);
      if (!existing) return { notFound: true };
      const activeTask = store.tasks.find(task => task.model_id === modelId && !["completed", "partial_failed", "failed", "cancelled"].includes(task.status));
      if (activeTask) return { error: { status: 409, body: { error: "MODEL_IN_USE", message: "该模特有处理中的任务，暂不能移除。" } } };
      if (existing.source === "system") {
        const previous = store.model_library_changes.find(item => item.id === modelId);
        if (previous) { previous.deleted = true; previous.updated_at = now(); }
        else { store.model_library_changes.push({ id: modelId, deleted: true, fields: {}, updated_at: now() }); }
      } else {
        const index = store.model_assets.findIndex(item => item.id === modelId);
        if (index === -1) return { notFound: true };
        store.model_assets[index].deleted_at = now();
      }
      if (store.model_assets.filter(item => !item.deleted_at).length === 0 && modelLibrary(store).length === 0) {
        return { error: { status: 409, body: { error: "LAST_MODEL_NOT_REMOVABLE", message: "至少需要保留一个可用模特。" } } };
      }
      return { data: { id: modelId, deleted: true } };
    });
    if (result.notFound) return notFound(res);
    if (result.error) { send(res, result.error.status, result.error.body); return; }
    send(res, 200, { data: result.data });
    return;
  }

  // ── Credits (user-scoped) ──

  if (req.method === "GET" && pathname === "/v1/credits/balance") {
    const store = readStore();
    const user = getCurrentUser(store, req.userId);
    send(res, 200, { data: { balance: user ? user.credit_balance : 0, currency: "credits" } });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/credits/logs") {
    const store = readStore();
    const isAdmin = req.userRole === "admin";
    const logs = store.credit_logs.filter(l => isAdmin || l.user_id === req.userId).slice().reverse();
    send(res, 200, { data: logs });
    return;
  }

  // ── Stats (user-scoped) ──

  if (req.method === "GET" && pathname === "/v1/stats") {
    const store = readStore();
    const nowDate = new Date();
    const thisMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1).toISOString();
    const isAdmin = req.userRole === "admin";
    const userTasks = store.tasks.filter(t => isAdmin || t.user_id === req.userId);
    const monthTasks = userTasks.filter(t => t.created_at >= thisMonthStart);
    const terminalTasks = monthTasks.filter(t => ["completed", "partial_failed", "failed", "cancelled"].includes(t.status));
    const completedTasks = terminalTasks.filter(t => t.status === "completed" || t.status === "partial_failed");
    const successRate = terminalTasks.length ? Math.round((completedTasks.length / terminalTasks.length) * 1000) / 10 : 100;
    const activeTasks = userTasks.filter(t => !["completed", "partial_failed", "failed", "cancelled"].includes(t.status));
    const monthlyCreditsUsed = store.credit_logs
      .filter(l => (isAdmin || l.user_id === req.userId) && l.created_at >= thisMonthStart && l.direction === "debit" && l.reason === "precharge")
      .reduce((sum, l) => sum + Math.abs(l.amount), 0);
    const user = getCurrentUser(store, req.userId);
    send(res, 200, { data: {
      monthly_tasks: monthTasks.length,
      success_rate: successRate,
      available_credits: user ? user.credit_balance : 0,
      active_tasks: activeTasks.length,
      monthly_credits_used: monthlyCreditsUsed
    }});
    return;
  }

  // ── Assets ──

  if (req.method === "POST" && pathname === "/v1/assets/upload-token") {
    const body = await parseBody(req);
    const token = oss.createUploadToken({
      fileName: body.file_name, contentType: body.content_type || body.mime_type || "application/octet-stream",
      folder: body.asset_type === "model" ? "models" : "uploads"
    });
    if (token) { send(res, 200, { data: token }); return; }
    send(res, 200, { data: { upload_id: id("upload"), method: "demo-local-json", object_key: `${req.tenantId}/uploads/${Date.now()}-${body.file_name || "asset"}`, expires_in: 1800 } });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/assets/upload-data-url") {
    try {
      const body = await parseBody(req);
      const folder = body.asset_type === "model" ? "models" : "uploads";
      const result = saveDataUrlToLocal(body.data_url, body.file_name, folder);
      if (!result) { send(res, 422, { error: "INVALID_DATA_URL", message: "无法解析 data URL。" }); return; }
      send(res, 200, { data: result });
    } catch (error) {
      send(res, 502, { error: "UPLOAD_FAILED", message: `上传失败：${error.message}` });
    }
    return;
  }

  // ── Garments ──

  if (req.method === "POST" && pathname === "/v1/garments/analyze") {
    const body = await parseBody(req);
    body.file = await normalizeUploadedFile(body.file, "uploads");
    const fallbackInferred = inferGarment(body.file?.name, body.description);
    let classifier = null;
    try {
      classifier = await classifyGarmentImage({ imageUrl: body.file?.url || body.file?.read_url || body.file?.data_url, fileName: body.file?.name, description: body.description });
    } catch (error) {
      classifier = { ...fallbackInferred, confidence: 0, source: "fallback", reason: `模型识别暂不可用，已使用文件名/文本兜底：${error.message}` };
    }
    const garment = await updateStore(store => {
      const inferred = classifier && classifier.confidence >= 0.55 ? classifier : fallbackInferred;
      const risk_flags = riskFromFile(body.file);
      if (classifier?.fashn_input_risk === "high") {
        risk_flags.push({ code: "fashn_input_high_risk", level: "warn", message: `FASHN 输入风险较高：${classifier.fashn_risk_reason || "建议使用平铺、衣架或假人商品图。"}` });
      } else if (classifier?.fashn_input_risk === "medium") {
        risk_flags.push({ code: "fashn_input_medium_risk", level: "warn", message: `FASHN 输入存在一定风险：${classifier.fashn_risk_reason || "如果生成失败，请改用更干净的商品图。"}` });
      }
      const entry = {
        id: id("garment"), tenant_id: req.tenantId, user_id: req.userId,
        file_name: body.file?.name || "demo-garment.png",
        file_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
        preview_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
        size_bytes: Number(body.file?.size || 0), mime_type: body.file?.type || null,
        object_key: body.file?.object_key || null,
        category: inferred.category, category_label: inferred.label, category_key: inferred.key,
        tryon_slot: inferred.tryon_slot, requires_full_body: Boolean(inferred.requires_full_body),
        color: body.color || "自动识别", material: body.material || "混纺/未知", pattern: body.pattern || "纯色或轻微图案", length: inferred.length,
        risk_flags,
        analysis: {
          clarity: risk_flags.some(item => item.code === "low_resolution") ? "low" : "good",
          subject_integrity: "passed", sensitive_content: "passed",
          category_source: inferred.source || "filename_rule",
          category_confidence: Number(inferred.confidence || (inferred.source === "vision_model" ? 0.72 : 0.5)),
          category_reason: inferred.reason || "根据文件名和业务描述识别。",
          category_model: inferred.model || null,
          fashn_input_risk: classifier?.fashn_input_risk || "unknown",
          fashn_risk_reason: classifier?.fashn_risk_reason || "",
          fashn_contains_person: Boolean(classifier?.contains_person),
          fashn_visible_skin_or_body: Boolean(classifier?.visible_skin_or_body),
          fashn_intimate_or_swimwear: Boolean(classifier?.intimate_or_swimwear),
          fashn_watermark_or_sensitive_text: Boolean(classifier?.watermark_or_sensitive_text),
          fallback_category: fallbackInferred.category
        },
        created_at: now()
      };
      store.garments.push(entry);
      return entry;
    });
    send(res, 200, { data: garment });
    return;
  }

  if (req.method === "PUT" && pathname.match(/^\/v1\/garments\/[^/]+\/category$/)) {
    const garmentId = decodeURIComponent(pathname.split("/")[3]);
    const body = await parseBody(req);
    const updatedGarment = await updateStore(store => {
      const garment = store.garments.find(item => item.id === garmentId);
      if (!garment) return null;
      const normalized = normalizeGarmentCategory(body.category_key || body.category, garment);
      garment.category = normalized.category; garment.category_label = normalized.label;
      garment.category_key = normalized.key; garment.length = normalized.length;
      garment.tryon_slot = normalized.tryon_slot; garment.requires_full_body = Boolean(normalized.requires_full_body);
      garment.analysis = { ...(garment.analysis || {}), category_source: "user_confirmed", category_confidence: 1, category_reason: "用户在页面二次确认服装品类。" };
      garment.updated_at = now();
      return garment;
    });
    if (!updatedGarment) { send(res, 404, { error: "GARMENT_NOT_FOUND", message: "服装图不存在" }); return; }
    send(res, 200, { data: updatedGarment });
    return;
  }

  // ── Model validation ──

  if (req.method === "POST" && pathname === "/v1/models/validate") {
    const body = await parseBody(req);
    body.file = await normalizeUploadedFile(body.file, "models");
    let model;
    if (body.model_id) {
      const store = readStore();
      model = findModelById(store, body.model_id);
    } else {
      model = await updateStore(store => {
        const entry = {
          id: id("model"), name: body.file?.name || "用户上传模特", source: "user_upload",
          gender: "unknown", body_type: "regular", pose_type: "full_body_standing",
          file_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
          preview_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
          size_bytes: Number(body.file?.size || 0), mime_type: body.file?.type || null,
          object_key: body.file?.object_key || null, preview_color: "#0f766e",
          risk_flags: riskFromFile(body.file)
        };
        store.model_assets.push({ ...entry, tenant_id: req.tenantId, user_id: req.userId, created_at: now() });
        return entry;
      });
    }
    if (!model) { send(res, 404, { error: "MODEL_NOT_FOUND", message: "模特不存在" }); return; }
    send(res, 200, { data: { ...model, validation: { person: "passed", pose: "passed", sensitive_content: "passed" } } });
    return;
  }

  // ── Agent recommendations ──

  if (req.method === "POST" && pathname === "/v1/agent/recommendations") {
    const body = await parseBody(req);
    const store = readStore();
    const garment = store.garments.find(item => item.id === body.garment_id) || inferGarment("", body.intent);
    const model = findModelById(store, body.model_id) || modelLibrary(store)[0];
    send(res, 200, { data: recommendParams({ garment, model, intent: body.intent, platform: body.platform_use }) });
    return;
  }

  // ── Tasks ──

  if (req.method === "POST" && pathname === "/v1/tryon/tasks") {
    const body = await parseBody(req);
    const store = readStore();
    const user = getCurrentUser(store, req.userId);
    if (!user) { send(res, 404, { error: "USER_NOT_FOUND", message: "用户不存在。" }); return; }
    const garment = store.garments.find(item => item.id === body.garment_id);
    const model = findModelById(store, body.model_id);
    const outputType = body.output_type || "image";
    const needsImageTryon = outputType === "image" || outputType === "image_video";
    const rawParams = body.params || {};
    const rawGarmentReferences = Array.isArray(rawParams.garment_references) ? rawParams.garment_references : [];

    if (rawGarmentReferences.length > MAX_GARMENT_REFERENCE_IMAGES) {
      send(res, 422, { error: "GARMENT_REFERENCE_LIMIT_EXCEEDED", message: `服装细节参考图最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张，任务未提交，未扣额度。`, detail: { code: "GARMENT_REFERENCE_LIMIT_EXCEEDED", userMessage: "服装细节参考图数量超过上限。", suggestion: `请保留最关键的背面、Logo、印花、面料、领口、袖口等参考图，最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张。` } });
      return;
    }
    const params = { ...rawParams, garment_references: normalizeGarmentReferenceImages(rawGarmentReferences) };
    const selectedTryonModel = params?.image?.tryon_model || "";

    const isGptImageTryon = selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image";
    // Collect OSS upload tokens to apply atomically inside updateStore below
    const needsOssUpload = needsImageTryon && !isGptImageTryon && oss.isConfigured();
    let ossUpdates = null;
    if (needsOssUpload) {
      const uploadLocalUrlToOss = async (localUrl, fileName, folder) => {
        if (!localUrl || isRemoteUrl(localUrl)) return null;
        const match = String(localUrl).match(/^\/v1\/media\/(uploads|models)\/([^/]+)$/);
        if (!match) return null;
        const filePath = path.join(DATA_DIR, match[1], match[2]);
        if (!fs.existsSync(filePath)) return null;
        try {
          const token = await oss.uploadLocalFileToOss({ filePath, fileName, folder });
          return token || null;
        } catch {
          return null;
        }
      };
      ossUpdates = { garment: null, model: null, refs: [] };
      if (garment && !isRemoteUrl(garment.file_url)) {
        ossUpdates.garment = await uploadLocalUrlToOss(garment.file_url, garment.file_name || "garment.jpg", "uploads");
      }
      if (model && !isRemoteUrl(model.file_url || model.preview_url)) {
        ossUpdates.model = await uploadLocalUrlToOss(model.file_url || model.preview_url, model.name || "model.jpg", "models");
      }
      for (const ref of params.garment_references) {
        if (ref.file_url && !isRemoteUrl(ref.file_url)) {
          ossUpdates.refs.push({ ref, token: await uploadLocalUrlToOss(ref.file_url, ref.name || "reference.jpg", "uploads") });
        }
      }
    }

    if (needsImageTryon && (selectedTryonModel === "aliyun:aitryon-plus" || (!selectedTryonModel && (process.env.AI_IMAGE_PROVIDER || "").toLowerCase() === "aliyun"))) {
      const validationErrors = validateAliyunTryonInputs({ garment, model });
      if (validationErrors.length) {
        send(res, 422, { error: "ALIYUN_TRYON_INPUT_INVALID", message: validationErrors.join(" "), detail: { code: "ALIYUN_TRYON_INPUT_INVALID", userMessage: "百炼试衣输入不符合要求，任务未提交，未扣额度。", suggestion: "请上传 5KB-20MB 的服装平铺图，以及 5KB-20MB 的正面全身真人模特图；两张图都需要成功上传 OSS。", validation_errors: validationErrors } });
        return;
      }
    }
    if (needsImageTryon && selectedTryonModel === "replicate:idm-vton" && !process.env.REPLICATE_API_TOKEN) {
      send(res, 422, { error: "REPLICATE_TOKEN_MISSING", message: "未配置 Replicate API Token，无法使用 IDM-VTON。", detail: { code: "REPLICATE_TOKEN_MISSING", userMessage: "IDM-VTON 未配置 API Token，任务未提交，未扣额度。", suggestion: "请在 .env 中配置 REPLICATE_API_TOKEN 后重启后端，或切换回百炼 AI 试衣 Plus。" } });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "pixelcut:try-on" || selectedTryonModel === "pixelcut") && !process.env.PIXELCUT_API_KEY) {
      send(res, 422, { error: "PIXELCUT_TOKEN_MISSING", message: "未配置 Pixelcut API Key，无法使用 Pixelcut Try-On。", detail: { code: "PIXELCUT_TOKEN_MISSING", userMessage: "Pixelcut Try-On 未配置 API Key，任务未提交，未扣额度。", suggestion: "请在 .env 中配置 PIXELCUT_API_KEY 后重启后端，或切换到百炼 AI 试衣 Plus。" } });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "302:fashn-tryon" || selectedTryonModel === "302:fashn-tryon-v1.5") && !(process.env.THREE_O_TWO_API_KEY || process.env.API_302_KEY || process.env.OPENAI_API_KEY)) {
      send(res, 422, { error: "THREE_O_TWO_TOKEN_MISSING", message: "未配置 302.AI API Key，无法使用 FASHN Try-On。", detail: { code: "THREE_O_TWO_TOKEN_MISSING", userMessage: "302.AI FASHN Try-On 未配置 API Key，任务未提交，未扣额度。", suggestion: "请在 .env 中配置 THREE_O_TWO_API_KEY，或复用已配置的 302.AI Key，然后重启后端。" } });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "302:fashn-tryon" || selectedTryonModel === "302:fashn-tryon-v1.5")) {
      const validationErrors = validateFashnTryonInputs({ garment, model });
      if (validationErrors.length) {
        send(res, 422, { error: "FASHN_INPUT_INVALID", message: validationErrors.join(" "), detail: { code: "FASHN_INPUT_INVALID", userMessage: "302.AI/FASHN 输入素材缺少必要信息，任务未提交，未扣额度。", suggestion: "请确认服装主图和真人模特图都已上传成功，并且都是可公网访问的 HTTP/HTTPS 图片 URL。", validation_errors: validationErrors } });
        return;
      }
    }
    if (needsImageTryon && (selectedTryonModel === "pixazo:fashn-vton" || selectedTryonModel === "pixazo:idm-vton" || selectedTryonModel === "pixazo:dm-vton") && !(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY)) {
      send(res, 422, { error: "PIXAZO_TOKEN_MISSING", message: "未配置 Pixazo API Key，无法使用 Pixazo VTON。", detail: { code: "PIXAZO_TOKEN_MISSING", userMessage: "Pixazo VTON 未配置 API Key，任务未提交，未扣额度。", suggestion: "请在 .env 中配置 PIXAZO_API_KEY 后重启后端，或先切换回百炼 AI 试衣 Plus。" } });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image")) {
      if (process.env.GPT_IMAGE_TRYON_ENABLED !== "true") {
        send(res, 422, { error: "GPT_IMAGE_TRYON_DISABLED", message: "GPT-Image 直接试衣功能未启用。", detail: { code: "GPT_IMAGE_TRYON_DISABLED", userMessage: "GPT-Image 直接试衣功能未启用，任务未提交，未扣额度。", suggestion: "请在 .env 中设置 GPT_IMAGE_TRYON_ENABLED=true 后重启后端。" } });
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        send(res, 422, { error: "OPENAI_API_KEY_MISSING", message: "未配置 OPENAI_API_KEY，无法使用 GPT-Image 直接试衣。", detail: { code: "OPENAI_API_KEY_MISSING", userMessage: "GPT-Image 直接试衣需要配置 OPENAI_API_KEY，任务未提交，未扣额度。", suggestion: "请在 .env 中配置 OPENAI_API_KEY 和 OPENAI_IMAGE_EDIT_URL 后重启后端。" } });
        return;
      }
    }

    const cost = creditCost({ ...body, params });
    const task = await updateStore(store => {
      // Apply OSS upload URL updates atomically to avoid race conditions
      if (ossUpdates) {
        if (ossUpdates.garment) {
          const g = store.garments.find(item => item.id === body.garment_id);
          if (g) { g.file_url = ossUpdates.garment.read_url; g.preview_url = ossUpdates.garment.read_url; g.object_key = ossUpdates.garment.object_key; }
        }
        if (ossUpdates.model) {
          const m = findModelById(store, body.model_id);
          if (m) { m.file_url = ossUpdates.model.read_url; m.preview_url = ossUpdates.model.read_url; m.object_key = ossUpdates.model.object_key; }
          const origModel = store.model_assets.find(item => item.id === body.model_id);
          if (origModel) { origModel.file_url = ossUpdates.model.read_url; origModel.preview_url = ossUpdates.model.read_url; origModel.object_key = ossUpdates.model.object_key; }
        }
        for (const { ref, token } of ossUpdates.refs) {
          if (token) { ref.file_url = token.read_url; ref.read_url = token.read_url; ref.object_key = token.object_key; }
        }
      }
      const currentUser = store.users.find(u => u.id === req.userId);
      if (!currentUser || currentUser.credit_balance < cost) return { insufficient: true };
      currentUser.credit_balance -= cost;
      const entry = {
        id: id("task"), tenant_id: req.tenantId, user_id: req.userId,
        garment_id: body.garment_id, model_id: body.model_id,
        output_type: body.output_type || "image", prompt: body.prompt || "",
        params, status: "pending", progress: 1, current_stage: "pending",
        message: "任务已提交", credit_cost: cost, failure_reason: null,
        stage_timings: { submitted_at: now() },
        created_at: now(), updated_at: now()
      };
      store.tasks.push(entry);
      store.credit_logs.push({ id: id("credit"), tenant_id: req.tenantId, user_id: req.userId, task_id: entry.id, amount: -cost, direction: "debit", reason: "precharge", status: "reserved", created_at: now() });
      addEvent(store, entry.id, entry.status, entry.progress, entry.message);
      return entry;
    });
    if (task.insufficient) { send(res, 402, { error: "INSUFFICIENT_CREDITS", message: "额度不足，无法提交生成任务。" }); return; }
    scheduleTask(task.id);
    send(res, 201, { data: task });
    return;
  }

  // ── Task list (user-scoped) ──

  if (req.method === "GET" && pathname === "/v1/tryon/tasks") {
    const store = readStore();
    const isAdmin = req.userRole === "admin";
    const tasks = store.tasks.filter(t => isAdmin || t.user_id === req.userId).slice().reverse()
      .map(task => ({ ...task, results: store.results.filter(r => r.task_id === task.id) }));
    send(res, 200, { data: tasks });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/tryon/results") {
    const store = readStore();
    const isAdmin = req.userRole === "admin";
    const userTaskIds = new Set(store.tasks.filter(t => isAdmin || t.user_id === req.userId).map(t => t.id));
    const rows = store.results.filter(r => userTaskIds.has(r.task_id)).slice().reverse().map(result => {
      const task = store.tasks.find(item => item.id === result.task_id);
      return { ...result, task: task ? { id: task.id, output_type: task.output_type, status: task.status, commercial_status: task.commercial_status || null, created_at: task.created_at, prompt: task.prompt } : null };
    });
    send(res, 200, { data: rows });
    return;
  }

  const taskMatch = pathname.match(/^\/v1\/tryon\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const store = readStore();
    const task = store.tasks.find(item => item.id === taskMatch[1]);
    if (!task) return notFound(res);
    if (task.user_id !== req.userId && req.userRole !== "admin") return notFound(res);
    send(res, 200, { data: { ...task, results: store.results.filter(r => r.task_id === task.id), events: store.events.filter(e => e.task_id === task.id) } });
    return;
  }

  if (req.method === "DELETE" && taskMatch) {
    const taskId = taskMatch[1];
    const result = await updateStore(store => {
      const taskIndex = store.tasks.findIndex(item => item.id === taskId);
      if (taskIndex === -1) return { notFound: true };
      if (store.tasks[taskIndex].user_id !== req.userId && req.userRole !== "admin") return { notFound: true };
      const taskResults = store.results.filter(r => r.task_id === taskId);
      taskResults.forEach(r => {
        [r.image_url, r.cover_url, r.video_url].forEach(url => {
          if (url && !isRemoteUrl(url)) {
            const match = String(url).match(/^\/v1\/media\/(generated|uploads|models)\/([^/]+)$/);
            if (match) {
              const fp = path.join(DATA_DIR, match[1], match[2]);
              try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
            }
          }
        });
      });
      store.results = store.results.filter(r => r.task_id !== taskId);
      store.tasks.splice(taskIndex, 1);
      store.events = store.events.filter(e => e.task_id !== taskId);
      store.credit_logs = store.credit_logs.filter(l => l.task_id !== taskId);
      return { deleted: true };
    });
    if (result.notFound) return notFound(res);
    send(res, 200, { data: { id: taskId, deleted: true } });
    return;
  }

  const taskCancel = pathname.match(/^\/v1\/tryon\/tasks\/([^/]+)\/cancel$/);
  if (req.method === "POST" && taskCancel) {
    const taskId = taskCancel[1];
    const result = await updateStore(store => {
      const task = store.tasks.find(item => item.id === taskId);
      if (!task) return { notFound: true };
      if (["completed", "partial_failed", "failed", "cancelled"].includes(task.status)) return { notCancellable: true };
      task.status = "cancelled";
      task.progress = 100;
      task.updated_at = now();
      addEvent(store, taskId, "cancelled", 100, "用户手动取消任务");
      const log = store.credit_logs.find(l => l.task_id === taskId && l.reason === "precharge");
      if (log && log.status === "reserved") {
        log.status = "refunded";
        const taskUser = store.users.find(u => u.id === task.user_id);
        if (taskUser) taskUser.credit_balance += Math.abs(log.amount);
      }
      return { cancelled: true };
    });
    if (result.notFound) return notFound(res);
    if (result.notCancellable) { send(res, 409, { error: "TASK_NOT_CANCELLABLE", message: "任务已结束，无法取消。" }); return; }
    send(res, 200, { data: { id: taskId, status: "cancelled" } });
    return;
  }

  // ── Results ──

  const resultDownload = pathname.match(/^\/v1\/tryon\/results\/([^/]+)\/download$/);
  if (req.method === "GET" && resultDownload) {
    const store = readStore();
    const result = store.results.find(item => item.id === resultDownload[1]);
    if (!result) return notFound(res);
    if (result.download_allowed === false) {
      send(res, 409, { error: "RESULT_NOT_DOWNLOADABLE", message: "该素材未达到下载门槛。" });
      return;
    }
    send(res, 200, { data: { signed_url: result.media_type === "image" ? result.image_url : result.video_url, expires_in: 1800, file_name: `${result.id}.${result.media_type === "image" ? "svg" : "mp4"}` } });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/tryon/results/batch-delete") {
    const body = await parseBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];
    if (!ids.length) { send(res, 422, { error: "NO_IDS", message: "请提供要删除的结果 ID 列表。" }); return; }
    const removed = await updateStore(store => {
      let count = 0;
      ids.forEach(id => {
        const index = store.results.findIndex(item => item.id === id);
        if (index !== -1) { store.results.splice(index, 1); count++; }
      });
      return count;
    });
    send(res, 200, { data: { deleted: removed } });
    return;
  }

  const resultSingleMatch = pathname.match(/^\/v1\/tryon\/results\/([^/]+)$/);
  if (req.method === "DELETE" && resultSingleMatch) {
    const resultId = resultSingleMatch[1];
    const found = await updateStore(store => {
      const index = store.results.findIndex(item => item.id === resultId);
      if (index === -1) return false;
      store.results.splice(index, 1);
      return true;
    });
    if (!found) return notFound(res);
    send(res, 200, { data: { id: resultId, deleted: true } });
    return;
  }

  // ── Media serving ──

  const mediaMatch = pathname.match(/^\/v1\/media\/results\/([^/]+)\/(\d+)\.(svg|mp4)$/);
  if (req.method === "GET" && mediaMatch) {
    const [, taskId, index, ext] = mediaMatch;
    if (ext === "svg") { sendText(res, 200, svgForResult(taskId, Number(index)), "image/svg+xml; charset=utf-8"); return; }
    sendText(res, 200, "Demo MP4 placeholder.", "video/mp4");
    return;
  }

  const generatedMatch = pathname.match(/^\/v1\/media\/generated\/([^/]+)$/);
  if (req.method === "GET" && generatedMatch) {
    const fileName = path.basename(generatedMatch[1]);
    const filePath = path.join(DATA_DIR, "generated", fileName);
    if (!filePath.startsWith(path.join(DATA_DIR, "generated")) || !fs.existsSync(filePath)) return notFound(res);
    const ext = path.extname(fileName).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : "image/jpeg";
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const uploadsMatch = pathname.match(/^\/v1\/media\/(uploads|models)\/([^/]+)$/);
  if (req.method === "GET" && uploadsMatch) {
    const subDir = uploadsMatch[1];
    const fileName = path.basename(uploadsMatch[2]);
    const dirPath = path.join(DATA_DIR, subDir);
    const filePath = path.join(dirPath, fileName);
    if (!filePath.startsWith(dirPath) || !fs.existsSync(filePath)) return notFound(res);
    const ext = path.extname(fileName).toLowerCase();
    const type = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  notFound(res);
}

module.exports = { route };
