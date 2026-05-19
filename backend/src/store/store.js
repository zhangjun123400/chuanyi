const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const oss = require("../storage/oss");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const DB_FILE = path.join(DATA_DIR, "store.json");

const SYSTEM_MODELS = [
  {
    id: "model-eva-001",
    name: "Eva 欧美全身站姿",
    gender: "female",
    age_range: "25-30",
    skin_tone: "light",
    body_type: "slim",
    pose_type: "full_body_standing",
    categories: ["dress", "coat", "pants", "shirt"],
    preview_color: "#2563eb",
    file_url: process.env.SYSTEM_MODEL_EVA_URL || null,
    preview_url: process.env.SYSTEM_MODEL_EVA_URL || null
  },
  {
    id: "model-mia-002",
    name: "Mia 亚洲棚拍半身",
    gender: "female",
    age_range: "22-28",
    skin_tone: "medium",
    body_type: "regular",
    pose_type: "half_body",
    categories: ["shirt", "jacket", "sweater"],
    preview_color: "#0f766e",
    file_url: process.env.SYSTEM_MODEL_MIA_URL || null,
    preview_url: process.env.SYSTEM_MODEL_MIA_URL || null
  },
  {
    id: "model-noah-003",
    name: "Noah 男装慢走展示",
    gender: "male",
    age_range: "26-34",
    skin_tone: "medium",
    body_type: "athletic",
    pose_type: "walking",
    categories: ["coat", "pants", "shirt"],
    preview_color: "#6d28d9",
    file_url: process.env.SYSTEM_MODEL_NOAH_URL || null,
    preview_url: process.env.SYSTEM_MODEL_NOAH_URL || null
  }
];

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const nowStr = now();
    const initial = {
      tenants: [{ id: "tenant-demo", name: "Demo Fashion Studio", plan: "pro", created_at: nowStr, updated_at: nowStr }],
      users: [{ id: "user-demo", tenant_id: "tenant-demo", name: "运营演示账号", credit_balance: 1200 }],
      garments: [],
      model_assets: [],
      tasks: [],
      results: [],
      credit_logs: [],
      events: [],
      refresh_token_blacklist: [],
      admin_audit_logs: [],
      login_lockouts: {},
      created_at: nowStr,
      updated_at: nowStr
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

function readStore() {
  ensureStore();
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const store = JSON.parse(raw);
  return ensureStoreShape(store);
}

function cleanExpiredTokens(store) {
  const nowStr = now();
  store.refresh_token_blacklist = (store.refresh_token_blacklist || []).filter(
    entry => entry.expires_at > nowStr
  );
}

function cleanExpiredLockouts(store) {
  const nowStr = now();
  if (store.login_lockouts) {
    for (const [key, entry] of Object.entries(store.login_lockouts)) {
      if (entry.locked_until && entry.locked_until <= nowStr) {
        delete store.login_lockouts[key];
      }
    }
  }
}

function trimEvents(store) {
  const MAX_EVENTS = 500;
  if (store.events && store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(store.events.length - MAX_EVENTS);
  }
}

function writeStore(store) {
  store.model_assets = store.model_assets || [];
  store.model_library_changes = store.model_library_changes || [];
  store.refresh_token_blacklist = store.refresh_token_blacklist || [];
  store.admin_audit_logs = store.admin_audit_logs || [];
  store.login_lockouts = store.login_lockouts || {};
  cleanExpiredTokens(store);
  cleanExpiredLockouts(store);
  trimEvents(store);
  store.updated_at = now();
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

// Promise-based mutex for serializing write operations.
let writeMutex = Promise.resolve();

function updateStore(updater) {
  const prev = writeMutex;
  let release;
  writeMutex = new Promise(resolve => { release = resolve; });

  return prev.then(() => {
    const store = readStore();
    const result = updater(store);
    return Promise.resolve(result).then(value => {
      writeStore(store);
      release();
      return value;
    });
  }).catch(err => {
    release();
    throw err;
  });
}

// ── v2.0: User lookup helpers ──

function findUserByEmail(store, email) {
  return (store.users || []).find(u => u.email === email);
}

function countAdmins(store) {
  return (store.users || []).filter(u => u.role === "admin" && u.status === "active").length;
}

// ── v2.0: Seed default admin ──

function seedAdmin(store) {
  store.users = store.users || [];
  if (store.users.some(u => u.email === "admin@tryonstudio.local")) return null;

  const bcrypt = require("bcryptjs");
  const password = crypto.randomBytes(8).toString("hex");
  const hash = bcrypt.hashSync(password, 10);
  const nowStr = now();

  const adminUser = {
    id: id("user"),
    tenant_id: "tenant-demo",
    email: "admin@tryonstudio.local",
    name: "系统管理员",
    password_hash: hash,
    role: "admin",
    status: "active",
    credit_balance: 1200,
    token_version: 1,
    last_login_at: null,
    created_at: nowStr,
    updated_at: nowStr
  };

  store.users.push(adminUser);

  const credPath = path.join(__dirname, "..", "..", ".admin-credentials");
  fs.writeFileSync(credPath, `admin@tryonstudio.local\n${password}\n`);
  try { fs.chmodSync(credPath, 0o600); } catch (_) { /* best effort */ }

  console.log("初始管理员密码已写入 .admin-credentials，请妥善保存。首次登录后建议立即修改密码。");

  return { email: adminUser.email, password };
}

// ── v2.0: Backward-compatible migration ──

function ensureStoreShape(store) {
  store.model_assets = store.model_assets || [];
  store.model_library_changes = store.model_library_changes || [];
  store.refresh_token_blacklist = store.refresh_token_blacklist || [];
  store.admin_audit_logs = store.admin_audit_logs || [];
  store.login_lockouts = store.login_lockouts || {};
  store.garments = store.garments || [];
  store.tasks = store.tasks || [];
  store.results = store.results || [];
  store.credit_logs = store.credit_logs || [];
  store.events = store.events || [];

  const nowStr = now();

  // Migrate tenants
  (store.tenants || []).forEach(t => {
    if (!t.created_at) t.created_at = store.created_at || nowStr;
    if (!t.updated_at) t.updated_at = store.updated_at || nowStr;
  });

  // Migrate users
  (store.users || []).forEach(u => {
    if (!u.email) u.email = `user_${u.id}@auto.local`;
    if (!u.password_hash) {
      const bcrypt = require("bcryptjs");
      u.password_hash = bcrypt.hashSync(crypto.randomBytes(8).toString("hex"), 10);
    }
    if (!u.role) u.role = "admin";
    if (!u.status) u.status = "active";
    if (!u.token_version) u.token_version = 1;
    if (u.last_login_at === undefined) u.last_login_at = null;
    if (!u.created_at) u.created_at = nowStr;
    if (!u.updated_at) u.updated_at = nowStr;
  });

  // Migrate data: fill missing user_id
  [store.garments, store.model_assets, store.tasks, store.credit_logs].forEach(arr => {
    (arr || []).forEach(item => {
      if (!item.user_id) item.user_id = "user-demo";
    });
  });

  // Seed admin if no users exist
  seedAdmin(store);

  return store;
}

function parseCategories(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[,，/、\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function withFreshAssetReadUrl(asset) {
  if (!asset || !asset.object_key || !oss.isConfigured()) return asset;
  const readUrl = oss.createReadUrl({
    objectKey: asset.object_key,
    expiresIn: Number(process.env.ALIYUN_OSS_READ_EXPIRES_SECONDS || 86400)
  });
  if (!readUrl) return asset;
  return { ...asset, file_url: readUrl, preview_url: readUrl };
}

function modelLibrary(store) {
  ensureStoreShape(store);
  const changes = store.model_library_changes || [];
  const hiddenIds = new Set(changes.filter(item => item.deleted).map(item => item.id));
  const overrideMap = new Map(changes.filter(item => !item.deleted).map(item => [item.id, item.fields || {}]));
  const systemRows = SYSTEM_MODELS
    .filter(item => !hiddenIds.has(item.id))
    .map(item => ({
      ...item,
      ...(overrideMap.get(item.id) || {}),
      source: "system",
      editable: true,
      removable: true
    }));
  const customRows = (store.model_assets || [])
    .filter(item => !item.deleted_at)
    .map(item => ({
      ...withFreshAssetReadUrl(item),
      source: item.source || "user_upload",
      editable: true,
      removable: true
    }));
  const customIds = new Set(customRows.map(item => item.id));
  return [...systemRows.filter(item => !customIds.has(item.id)), ...customRows];
}

function findModelById(store, modelId) {
  return modelLibrary(store).find(item => item.id === modelId);
}

function normalizeModelPayload(body = {}, fallback = {}) {
  return {
    name: body.name || fallback.name || "未命名模特",
    gender: body.gender || fallback.gender || "unknown",
    age_range: body.age_range || fallback.age_range || "",
    skin_tone: body.skin_tone || fallback.skin_tone || "medium",
    body_type: body.body_type || fallback.body_type || "regular",
    pose_type: body.pose_type || fallback.pose_type || "full_body_standing",
    categories: parseCategories(body.categories || fallback.categories || ["dress", "coat", "pants", "shirt"]),
    preview_color: body.preview_color || fallback.preview_color || "#0f766e",
    file_url: body.file_url || fallback.file_url || null,
    preview_url: body.preview_url || body.file_url || fallback.preview_url || fallback.file_url || null,
    video_enabled: body.video_enabled === undefined ? Boolean(fallback.video_enabled) : Boolean(body.video_enabled),
    risk_tags: parseCategories(body.risk_tags || fallback.risk_tags || []),
    description: body.description || fallback.description || ""
  };
}

function addEvent(store, taskId, status, progress, message) {
  store.events.push({ id: id("event"), task_id: taskId, status, progress, message, created_at: now() });
}

module.exports = {
  id, now, ensureStore, readStore, writeStore, updateStore, ensureStoreShape,
  parseCategories, withFreshAssetReadUrl, modelLibrary, findModelById,
  normalizeModelPayload, addEvent, SYSTEM_MODELS,
  findUserByEmail, countAdmins, seedAdmin, cleanExpiredTokens
};
