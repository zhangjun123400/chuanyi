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
      tenants: [{ id: "tenant-demo", name: "Demo Fashion Studio", plan: "pro" }],
      users: [{ id: "user-demo", tenant_id: "tenant-demo", name: "运营演示账号", credit_balance: 1200 }],
      garments: [],
      model_assets: [],
      tasks: [],
      results: [],
      credit_logs: [],
      events: [],
      created_at: nowStr,
      updated_at: nowStr
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
}

function readStore() {
  ensureStore();
  return ensureStoreShape(JSON.parse(fs.readFileSync(DB_FILE, "utf8")));
}

function writeStore(store) {
  store.model_assets = store.model_assets || [];
  store.model_library_changes = store.model_library_changes || [];
  store.updated_at = now();
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

function ensureStoreShape(store) {
  store.model_assets = store.model_assets || [];
  store.model_library_changes = store.model_library_changes || [];
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
  id, now, ensureStore, readStore, writeStore, ensureStoreShape,
  parseCategories, withFreshAssetReadUrl, modelLibrary, findModelById,
  normalizeModelPayload, addEvent, SYSTEM_MODELS
};
