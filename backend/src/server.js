const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadEnv } = require("./env");

loadEnv();

const { generateTryOnImage, generateTryOnVideo, optimizeImageWithOpenAI, classifyGarmentImage, validateTryOnEffectWithVision } = require("./ai/model-gateway");
const oss = require("./storage/oss");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "store.json");
const MIN_IMAGE_UPLOAD_BYTES = 5 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const PROVIDER_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PROVIDER_MIN_IMAGE_EDGE = 150;
const PROVIDER_MAX_IMAGE_EDGE = 4096;
const MAX_JSON_BODY_BYTES = 35 * 1024 * 1024;
const MAX_GARMENT_REFERENCE_IMAGES = 10;

const STATUS_FLOW_IMAGE = [
  ["pending", 5, "任务已提交，等待队列"],
  ["prechecking", 12, "正在进行生成前质量预检"],
  ["pre_editing", 22, "正在做试衣前素材改图"],
  ["virtual_tryon", 42, "正在虚拟试衣中"],
  ["tryon_refining", 62, "正在进行试衣图精修"],
  ["effect_validating", 76, "正在检查试衣是否生效"],
  ["gpt_image_optimizing", 88, "正在进行最终商用出图"],
  ["quality_scoring", 96, "正在进行商用品质评分"],
  ["completed", 100, "生成完成"]
];

const STATUS_FLOW_VIDEO = [
  ["pending", 4, "任务已提交，等待视频队列"],
  ["prechecking", 14, "正在进行生成前质量预检"],
  ["generating_keyframes", 32, "正在生成试穿关键帧"],
  ["rendering_video", 68, "正在生成试穿视频"],
  ["frame_checking", 82, "正在检查帧一致性"],
  ["encoding", 93, "正在编码导出 MP4"],
  ["completed", 100, "生成完成"]
];

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

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const now = new Date().toISOString();
    const initial = {
      tenants: [{ id: "tenant-demo", name: "Demo Fashion Studio", plan: "pro" }],
      users: [{ id: "user-demo", tenant_id: "tenant-demo", name: "运营演示账号", credit_balance: 1200 }],
      garments: [],
      model_assets: [],
      tasks: [],
      results: [],
      credit_logs: [],
      events: [],
      created_at: now,
      updated_at: now
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
  store.updated_at = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

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
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("JSON 格式错误"));
      }
    });
  });
}

const GARMENT_CATEGORY_OPTIONS = {
  camisole: { category: "shirt", label: "吊带/背心", length: "upper", tryon_slot: "top", requires_full_body: false },
  base_layer: { category: "shirt", label: "打底衫", length: "upper", tryon_slot: "top", requires_full_body: false },
  tshirt: { category: "shirt", label: "T恤", length: "upper", tryon_slot: "top", requires_full_body: false },
  shirt: { category: "shirt", label: "衬衫/上衣", length: "upper", tryon_slot: "top", requires_full_body: false },
  knitwear: { category: "shirt", label: "针织衫/毛衣", length: "upper", tryon_slot: "top", requires_full_body: false },
  hoodie: { category: "shirt", label: "卫衣", length: "upper", tryon_slot: "top", requires_full_body: false },
  jacket: { category: "shirt", label: "夹克/外套", length: "medium", tryon_slot: "top", requires_full_body: false },
  coat: { category: "shirt", label: "风衣/大衣", length: "long", tryon_slot: "top", requires_full_body: true },
  down_jacket: { category: "shirt", label: "羽绒服", length: "medium", tryon_slot: "top", requires_full_body: false },
  blazer: { category: "shirt", label: "西装/开衫", length: "medium", tryon_slot: "top", requires_full_body: false },
  skirt: { category: "pants", label: "半身裙", length: "lower", tryon_slot: "bottom", requires_full_body: true },
  shorts: { category: "pants", label: "短裤", length: "lower", tryon_slot: "bottom", requires_full_body: true },
  pants: { category: "pants", label: "长裤/裤装", length: "long", tryon_slot: "bottom", requires_full_body: true },
  wide_leg_pants: { category: "pants", label: "阔腿裤/喇叭裤", length: "long", tryon_slot: "bottom", requires_full_body: true },
  leggings: { category: "pants", label: "紧身裤/瑜伽裤", length: "long", tryon_slot: "bottom", requires_full_body: true },
  dress: { category: "dress", label: "连衣裙", length: "full", tryon_slot: "top", requires_full_body: true },
  jumpsuit: { category: "dress", label: "连体裤/连体衣", length: "full", tryon_slot: "top", requires_full_body: true },
  swimsuit: { category: "dress", label: "连身泳衣", length: "full", tryon_slot: "top", requires_full_body: true },
  sleepwear: { category: "dress", label: "睡衣/家居服", length: "full", tryon_slot: "top", requires_full_body: true },
  underwear: { category: "shirt", label: "内衣/塑身衣", length: "upper", tryon_slot: "top", requires_full_body: false },
  sportswear: { category: "shirt", label: "运动上衣/冲锋衣/防晒衣", length: "upper", tryon_slot: "top", requires_full_body: false },
  formal_dress: { category: "dress", label: "婚纱/礼服", length: "full", tryon_slot: "top", requires_full_body: true },
  traditional: { category: "dress", label: "汉服/旗袍/和服", length: "full", tryon_slot: "top", requires_full_body: true },
  protective: { category: "shirt", label: "围裙/实验服/雨衣", length: "medium", tryon_slot: "top", requires_full_body: false }
};

function normalizeGarmentCategory(value, fallback) {
  const key = String(value || "").trim();
  if (GARMENT_CATEGORY_OPTIONS[key]) return { key, ...GARMENT_CATEGORY_OPTIONS[key] };
  if (fallback?.category === "pants") return { key: "pants", ...GARMENT_CATEGORY_OPTIONS.pants };
  if (fallback?.category === "dress") return { key: "dress", ...GARMENT_CATEGORY_OPTIONS.dress };
  return { key: "shirt", ...GARMENT_CATEGORY_OPTIONS.shirt };
}

function inferGarment(fileName = "", description = "") {
  const source = `${fileName} ${description}`.toLowerCase();
  if (/jumpsuit|romper|连体裤|连体衣/.test(source)) return normalizeGarmentCategory("jumpsuit");
  if (/wedding|gown|礼服|婚纱/.test(source)) return normalizeGarmentCategory("formal_dress");
  if (/hanfu|qipao|kimono|汉服|旗袍|和服/.test(source)) return normalizeGarmentCategory("traditional");
  if (/dress|连衣|睡裙/.test(source)) return normalizeGarmentCategory("dress");
  if (/skirt|半身裙|a字裙|百褶裙|包臀裙|伞裙|短裙|中长裙/.test(source)) return normalizeGarmentCategory("skirt");
  if (/shorts|短裤/.test(source)) return normalizeGarmentCategory("shorts");
  if (/leggings|yoga|瑜伽裤|紧身裤/.test(source)) return normalizeGarmentCategory("leggings");
  if (/pants|trouser|jeans|裤/.test(source)) return normalizeGarmentCategory("pants");
  if (/coat|trench|大衣|风衣/.test(source)) return normalizeGarmentCategory("coat");
  if (/jacket|外套|夹克|皮衣/.test(source)) return normalizeGarmentCategory("jacket");
  if (/shirt|tee|top|衬衫|上衣|t恤/.test(source)) return normalizeGarmentCategory("shirt");
  return normalizeGarmentCategory("dress");
}

function riskFromFile(file) {
  const riskFlags = [];
  const name = String(file?.name || "").toLowerCase();
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (file && file.type && !allowed.includes(file.type)) {
    riskFlags.push({ code: "unsupported_format", level: "block", message: "当前格式暂不支持，请上传 JPG、PNG 或 WebP。" });
  }
  if (file && Number(file.size || 0) > MAX_IMAGE_UPLOAD_BYTES) {
    riskFlags.push({ code: "file_too_large", level: "block", message: "图片超过 20MB，请压缩后上传。" });
  }
  if (file?.expected_role === "garment" && /(模特|model|person|真人|人像|全身)/i.test(name)) {
    riskFlags.push({ code: "role_may_be_person", level: "warn", message: "这张图片文件名像真人/模特图，请确认没有把模特图上传到服装区。" });
  }
  if (file?.expected_role === "model" && /(衣|裙|裤|上衣|外套|garment|cloth|shirt|dress|pants|coat)/i.test(name)) {
    riskFlags.push({ code: "role_may_be_garment", level: "warn", message: "这张图片文件名像服装图，请确认没有把服装图上传到模特区。" });
  }
  if ((process.env.AI_IMAGE_PROVIDER || "").toLowerCase() === "aliyun") {
    const size = Number(file?.size || 0);
    if (size > 0 && size < MIN_IMAGE_UPLOAD_BYTES) {
      riskFlags.push({ code: "aliyun_file_too_small", level: "block", message: "百炼 AI 试衣要求图片大于 5KB，请更换图片。" });
    }
    if (size > MAX_IMAGE_UPLOAD_BYTES) {
      riskFlags.push({ code: "aliyun_file_too_large", level: "block", message: "图片超过 20MB，请压缩后上传。" });
    }
  }
  if (file && Number(file.width || 1600) < 1024 && Number(file.height || 1600) < 1024) {
    riskFlags.push({ code: "low_resolution", level: "warn", message: "图片清晰度较低，建议替换为长边大于 1024px 的图片。" });
  }
  return riskFlags;
}

function isRemoteUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function normalizeGarmentReferenceImages(value) {
  const items = Array.isArray(value) ? value : [];
  return items.slice(0, MAX_GARMENT_REFERENCE_IMAGES).map((item, index) => {
    const url = item?.file_url || item?.url || item?.read_url || item?.preview_url || item?.data_url;
    return {
      name: item?.name || `服装细节参考图${index + 1}`,
      file_url: url || null,
      preview_url: item?.preview_url || url || null,
      read_url: item?.read_url || url || null,
      object_key: item?.object_key || null,
      mime_type: item?.mime_type || item?.type || null,
      size_bytes: Number(item?.size_bytes || item?.size || 0),
      width: Number(item?.width || 0),
      height: Number(item?.height || 0)
    };
  }).filter(item => item.file_url);
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
  return {
    ...asset,
    file_url: readUrl,
    preview_url: readUrl
  };
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

function validateAliyunTryonInputs({ garment, model }) {
  const errors = [];
  if (!garment) errors.push("缺少服装图。");
  if (!model) errors.push("缺少真人模特图，请上传一张正面全身真人照片。");
  if (garment && !isRemoteUrl(garment.file_url)) {
    errors.push("服装图不是公网 HTTP/HTTPS URL，请确认 OSS 上传成功。");
  }
  if (model && !isRemoteUrl(model.file_url || model.preview_url)) {
    errors.push("真人模特图不是公网 HTTP/HTTPS URL，请确认已上传真人模特图且 OSS 上传成功。");
  }
  if (garment?.size_bytes && Number(garment.size_bytes) > MAX_IMAGE_UPLOAD_BYTES) {
    errors.push("服装图超过 20MB 上限，请压缩后重新上传。");
  }
  if (model?.size_bytes && Number(model.size_bytes) > MAX_IMAGE_UPLOAD_BYTES) {
    errors.push("真人模特图超过 20MB 上限，请压缩后重新上传。");
  }
  if (garment?.size_bytes && Number(garment.size_bytes) > PROVIDER_MAX_IMAGE_BYTES) {
    errors.push("服装图未生成模型合规图：当前超过百炼 5MB 限制，请重新上传服装图。");
  }
  if (model?.size_bytes && Number(model.size_bytes) > PROVIDER_MAX_IMAGE_BYTES) {
    errors.push(`模特图未生成模型合规图：当前约 ${Math.round(Number(model.size_bytes) / 1024 / 1024 * 10) / 10}MB，超过百炼 5MB 限制。请到系统模特库点击“修改”，重新上传该模特图。`);
  }
  const garmentWidth = Number(garment?.width || 0);
  const garmentHeight = Number(garment?.height || 0);
  const modelWidth = Number(model?.width || 0);
  const modelHeight = Number(model?.height || 0);
  if (garmentWidth && garmentHeight && (Math.max(garmentWidth, garmentHeight) >= PROVIDER_MAX_IMAGE_EDGE || Math.min(garmentWidth, garmentHeight) <= PROVIDER_MIN_IMAGE_EDGE)) {
    errors.push("服装图尺寸不符合百炼要求，请重新上传，系统会自动生成模型合规图。");
  }
  if (modelWidth && modelHeight && (Math.max(modelWidth, modelHeight) >= PROVIDER_MAX_IMAGE_EDGE || Math.min(modelWidth, modelHeight) <= PROVIDER_MIN_IMAGE_EDGE)) {
    errors.push("模特图尺寸不符合百炼要求，请在系统模特库中重新上传该模特图。");
  }
  if (garment?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`服装图预检未通过：${garment.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  if (model?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`真人模特图预检未通过：${model.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  if (garment?.requires_full_body && model?.pose_type === "half_body") {
    errors.push(`${garment.category_label || "当前服装"}需要全身模特图，当前选择的是半身模特，容易生成只穿上半身或缺少下摆，请更换正面全身模特照片。`);
  }
  if (/(模特|model|person|真人|人像|全身)/i.test(String(garment?.file_name || ""))) {
    errors.push("服装图文件名像真人/模特图，请检查是否把模特图上传到了服装区域。");
  }
  if (/(衣|裙|裤|上衣|外套|garment|cloth|shirt|dress|pants|coat)/i.test(String(model?.name || ""))) {
    errors.push("真人模特图文件名像服装图，请检查是否把服装图上传到了模特区域。");
  }
  return errors;
}

function validateFashnTryonInputs({ garment, model }) {
  const errors = [];
  if (!garment) errors.push("缺少服装主图。");
  if (!model) errors.push("缺少真人模特图。");
  if (garment && !isRemoteUrl(garment.file_url)) {
    errors.push("服装主图不是公网 HTTP/HTTPS URL，请确认 OSS 上传成功。");
  }
  if (model && !isRemoteUrl(model.file_url || model.preview_url)) {
    errors.push("真人模特图不是公网 HTTP/HTTPS URL，请确认已上传真人模特图且 OSS 上传成功。");
  }
  if (garment?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`服装主图预检未通过：${garment.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  if (model?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`真人模特图预检未通过：${model.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  return errors;
}

async function normalizeUploadedFile(file, folder) {
  if (!file) return file;
  if ((file.url || file.read_url) || !file.data_url || !oss.isConfigured()) return file;
  const token = await oss.uploadDataUrl({
    dataUrl: file.data_url,
    fileName: file.name,
    folder
  });
  if (!token) return file;
  return {
    ...file,
    url: token.read_url,
    read_url: token.read_url,
    object_key: token.object_key
  };
}

function recommendParams({ garment, model, intent = "", platform = "商品图" }) {
  const text = `${intent} ${platform}`.toLowerCase();
  const isVideo = /video|tiktok|reels|短视频|视频/.test(text);
  const ratio = /amazon|亚马逊|商品图/.test(text) ? "1:1" : isVideo ? "9:16" : "4:5";
  const background = /amazon|亚马逊/.test(text) ? "白底" : /street|街拍/.test(text) ? "街拍" : "干净棚拍";
  const template = garment.category === "pants" || garment.category === "dress" ? "轻微转身" : "静态镜头";
  const risks = [];
  if ((garment.requires_full_body || garment.category === "pants" || garment.category === "dress") && model && model.pose_type === "half_body") {
    risks.push(`${garment.category_label || "当前服装"}建议选择全身模特，当前半身姿态可能导致下摆、裙长或裤腿生成异常。`);
  }
  if (template === "轻微转身") {
    risks.push("视频模板会进行帧一致性检查，复杂图案建议选择增强模式。");
  }
  return {
    output_type: isVideo ? "image_video" : "image",
    image: {
      count: 4,
      ratio,
      background,
      keep_texture: true,
      quality_filter: true,
      platform_use: platform || "商品图"
    },
    video: {
      duration_seconds: isVideo ? 15 : 10,
      ratio: "9:16",
      motion_template: template,
      camera: garment.category === "shirt" ? "中景" : "中景全身",
      background,
      audio: "无",
      consistency: "标准"
    },
    pose_suggestion: garment.category === "shirt" ? "半身或中景站姿" : "全身站姿",
    risks
  };
}

function creditCost(payload) {
  const output = payload.output_type || "image";
  const count = Number(payload.params?.image?.count || payload.image_count || 4);
  const duration = Number(payload.params?.video?.duration_seconds || 0);
  const tryonModel = String(payload.params?.image?.tryon_model || "").toLowerCase();
  const isGptImageTryon = tryonModel === "gpt-image:try-on" || tryonModel === "gpt-image:tryon" || tryonModel === "gpt-image";
  let cost = 0;
  if (output === "image" || output === "image_video") cost += count * (isGptImageTryon ? 14 : 8);
  if (output === "video" || output === "image_video") cost += Math.max(6, duration || 15) * 6;
  return cost;
}

function apiCapabilities() {
  const imageProvider = (process.env.AI_IMAGE_PROVIDER || "mock").toLowerCase();
  const refinerEnabled = process.env.ALIYUN_TRYON_ENABLE_REFINER === "true";
  const preEditEnabled = Boolean(process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY);
  const imageOptimizerUrl = process.env.OPENAI_IMAGE_EDIT_URL || "https://api.openai.com/v1/images/edits";
  const imageOptimizerProvider = imageOptimizerUrl.includes("302.ai") ? "302.AI / ChatGPT Image" : "OpenAI / ChatGPT Image";
  const classifierUrl = process.env.OPENAI_CHAT_URL || "https://api.openai.com/v1/chat/completions";
  const classifierProvider = classifierUrl.includes("302.ai") ? "302.AI / OpenAI Vision" : "OpenAI Vision";
  const classifierEnabled = process.env.GARMENT_CLASSIFIER_ENABLED !== "false" && Boolean(process.env.OPENAI_API_KEY);
  const replicateIdmVtonEnabled = Boolean(process.env.REPLICATE_API_TOKEN);
  const pixazoVtonEnabled = Boolean(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY);
  const threeOhTwoFashnEnabled = Boolean(process.env.THREE_O_TWO_API_KEY || process.env.API_302_KEY || process.env.OPENAI_API_KEY);
  const pixelcutTryonEnabled = Boolean(process.env.PIXELCUT_API_KEY);
  const gptImageTryonEnabled = process.env.GPT_IMAGE_TRYON_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY);
  return {
    image_provider: imageProvider,
    tryon_model: imageProvider === "aliyun" ? process.env.ALIYUN_TRYON_MODEL || "aitryon-plus" : imageProvider,
    tryon_models: [
      { value: "gpt-image:try-on", label: "GPT-Image 1.5 · 直接试衣", commercial: true, enabled: gptImageTryonEnabled },
      { value: "pixelcut:try-on", label: "Pixelcut Try-On", commercial: true, enabled: pixelcutTryonEnabled },
      { value: "302:fashn-tryon", label: "302.AI FASHN Try-On v1.5", commercial: true, enabled: threeOhTwoFashnEnabled },
      { value: "aliyun:aitryon-plus", label: "百炼 AI 试衣 Plus", commercial: true, enabled: Boolean(process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY) },
      { value: "pixazo:fashn-vton", label: "Pixazo Fashn VTON", commercial: true, enabled: pixazoVtonEnabled },
      { value: "replicate:idm-vton", label: "Replicate IDM-VTON", commercial: false, enabled: replicateIdmVtonEnabled }
    ],
    pixelcut_tryon_enabled: pixelcutTryonEnabled,
    pixelcut_tryon_endpoint: process.env.PIXELCUT_TRYON_URL || "https://api.developer.pixelcut.ai/v1/try-on",
    three_oh_two_fashn_tryon_enabled: threeOhTwoFashnEnabled,
    three_oh_two_fashn_tryon_endpoint: process.env.THREE_O_TWO_FASHN_TRYON_URL || "https://api.302.ai/302/submit/fashn-tryon-v1.5",
    pixazo_idm_vton_enabled: pixazoVtonEnabled,
    pixazo_fashn_vton_enabled: pixazoVtonEnabled,
    pixazo_idm_vton_endpoint: process.env.PIXAZO_IDM_VTON_URL || "https://gateway.pixazo.ai/idm-vton-api/v1/r-idm-vton",
    pixazo_fashn_vton_endpoint: process.env.PIXAZO_FASHN_VTON_URL || "https://gateway.pixazo.ai/fashn-virtual-try-on/v1/fashn-virtual-try-on-request",
    replicate_idm_vton_enabled: replicateIdmVtonEnabled,
    replicate_idm_vton_model: process.env.REPLICATE_IDM_VTON_MODEL || "cuuupid/idm-vton",
    tryon_resolution: Number(process.env.ALIYUN_TRYON_RESOLUTION || 1280),
    refiner_enabled: refinerEnabled,
    refiner_model: refinerEnabled ? process.env.ALIYUN_REFINER_MODEL || "aitryon-refiner" : null,
    pre_edit_enabled: preEditEnabled,
    pre_edit_default_enabled: false,
    pre_edit_models: ["qwen-image-edit-plus", "qwen-image-2.0-pro", "qwen-image-edit-max"],
    default_pre_edit_model: process.env.ALIYUN_PRE_EDIT_MODEL || "qwen-image-edit-plus",
    openai_image_optimizer_enabled: Boolean(process.env.OPENAI_API_KEY),
    openai_image_optimizer_default_enabled: true,
    openai_image_optimizer_provider: imageOptimizerProvider,
    openai_image_optimizer_model: process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5",
    openai_image_optimizer_size: process.env.OPENAI_IMAGE_OPTIMIZER_SIZE || "1024x1536",
    garment_classifier_enabled: classifierEnabled,
    garment_classifier_provider: classifierProvider,
    garment_classifier_model: process.env.GARMENT_CLASSIFIER_MODEL || "gpt-4o-mini",
    tryon_effect_validator_enabled: process.env.TRYON_EFFECT_VALIDATOR_ENABLED !== "false" && Boolean(process.env.OPENAI_API_KEY),
    tryon_effect_validator_model: process.env.TRYON_EFFECT_VALIDATOR_MODEL || "gpt-4o",
    video_provider: (process.env.AI_VIDEO_PROVIDER || "mock").toLowerCase(),
    oss_configured: oss.isConfigured(),
    storage_mode: oss.isConfigured() ? "aliyun-oss-backend-relay" : "local-demo",
    content_safety: "provider-inspection",
    model_stack: [
      {
        name: "GPT-Image 直接试衣",
        provider: imageOptimizerProvider,
        model: process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5",
        status: gptImageTryonEnabled ? "启用" : "待配置",
        purpose: "跳过传统VTON模型，直接用GPT-Image-1.5从模特+服装参考图生成逼真试衣图"
      },
      {
        name: "图片虚拟试衣",
        provider: imageProvider === "aliyun" ? "阿里云百炼" : imageProvider,
        model: imageProvider === "aliyun" ? process.env.ALIYUN_TRYON_MODEL || "aitryon-plus" : imageProvider,
        status: imageProvider === "mock" ? "模拟" : "启用",
        purpose: "把服装穿到真人模特身上，生成试衣候选图"
      },
      {
        name: "图片虚拟试衣主链路候选",
        provider: "Pixelcut",
        model: "Try-On API",
        status: pixelcutTryonEnabled ? "可选，当前优先测试" : "待配置",
        purpose: "通过 Pixelcut Try-On API 生成真人模特试衣图，用于替代 302.AI/FASHN 误杀链路"
      },
      {
        name: "图片虚拟试衣主链路",
        provider: "302.AI / FASHN",
        model: "FASHN Try-On v1.5",
        status: threeOhTwoFashnEnabled ? "可选，建议优先测试" : "待配置",
        purpose: "通过 302.AI 调用 FASHN Try-On，用于替代百炼作为更高品质试衣主链路候选"
      },
      {
        name: "图片虚拟试衣备选",
        provider: "Pixazo",
        model: "Fashn Virtual Try-On",
        status: pixazoVtonEnabled ? "可选" : "待配置",
        purpose: "通过 Pixazo 调用可轮询的 Fashn VTON，作为百炼 Plus 之外的试衣效果对比通道"
      },
      {
        name: "图片虚拟试衣备选",
        provider: "Replicate",
        model: process.env.REPLICATE_IDM_VTON_MODEL || "cuuupid/idm-vton",
        status: replicateIdmVtonEnabled ? "可选，实验" : "待配置",
        purpose: "IDM-VTON 试衣模型，用于和百炼 Plus 做效果对比；模型页面标注 Non-Commercial use only"
      },
      {
        name: "试衣图精修",
        provider: "阿里云百炼",
        model: process.env.ALIYUN_REFINER_MODEL || "aitryon-refiner",
        status: refinerEnabled ? "启用" : "关闭",
        purpose: "优化试衣图真实感、边缘融合和服装纹理"
      },
      {
        name: "试衣前图改图",
        provider: "阿里云百炼 / Qwen Image",
        model: process.env.ALIYUN_PRE_EDIT_MODEL || "qwen-image-edit-plus",
        status: preEditEnabled ? "可选，默认关闭" : "待配置",
        purpose: "按 Agent 要求对服装图和模特图做保守预处理，默认关闭以保护原服装一致性"
      },
      {
        name: "服装品类识别",
        provider: classifierProvider,
        model: process.env.GARMENT_CLASSIFIER_MODEL || "gpt-4o-mini",
        status: classifierEnabled ? "启用" : "待配置",
        purpose: "识别上传服装是上衣、连衣裙还是裤装，并映射为百炼试衣入参"
      },
      {
        name: "试衣生效质检",
        provider: classifierProvider,
        model: process.env.TRYON_EFFECT_VALIDATOR_MODEL || "gpt-4o",
        status: process.env.TRYON_EFFECT_VALIDATOR_ENABLED !== "false" && Boolean(process.env.OPENAI_API_KEY) ? "启用" : "待配置",
        purpose: "对比原模特、目标服装和结果图，识别未换装或仍保留原衣服的失败结果"
      },
      {
        name: "最终商用出图",
        provider: imageOptimizerProvider,
        model: process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5",
        status: Boolean(process.env.OPENAI_API_KEY) ? "可选，默认关闭" : "待配置",
        purpose: "生成后提升清晰度、面料细节、边缘和电商质感，默认关闭以避免改动服装商品"
      },
      {
        name: "图生视频",
        provider: (process.env.AI_VIDEO_PROVIDER || "mock").toLowerCase() === "kling" ? "可灵 Kling" : (process.env.AI_VIDEO_PROVIDER || "mock"),
        model: process.env.KLING_VIDEO_MODEL || process.env.RUNWAY_VIDEO_MODEL || "mock-video",
        status: (process.env.AI_VIDEO_PROVIDER || "mock").toLowerCase() === "mock" ? "模拟" : "启用",
        purpose: "把推荐试衣图生成短视频展示"
      }
    ],
    commercial_quality: {
      recommended_threshold: 80,
      dimension_floor: 70,
      minimum_candidates: 4,
      required_recommended_count: 1,
      hd_target_long_edge: 2048
    }
  };
}

function addEvent(store, taskId, status, progress, message) {
  store.events.push({ id: id("event"), task_id: taskId, status, progress, message, created_at: now() });
}

function updateTaskStage(store, task, status, progress, message) {
  task.status = status;
  task.progress = progress;
  task.current_stage = status;
  task.message = message;
  task.updated_at = now();
  task.stage_timings[status] = task.updated_at;
  addEvent(store, task.id, status, progress, message);
  writeStore(store);
}

function validationFailed(validation) {
  if (!validation) return false;
  if (validation.product_fidelity_passed === false) return true;
  if (validation.color_match === false || validation.shape_length_match === false || validation.detail_texture_match === false) return true;
  if (Number(validation.color_score ?? 1) < 0.72) return true;
  if (Number(validation.shape_length_score ?? 1) < 0.72) return true;
  if (Number(validation.detail_texture_score ?? 1) < 0.72) return true;
  return validation.passed === false && Number(validation.confidence || 0) >= 0.55;
}

function stringifyErrorDetail(value, fallback = "") {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return String(value);
  }
}

function normalizeProviderError(error) {
  const raw = error?.message && error.message !== "[object Object]"
    ? error.message
    : stringifyErrorDetail(error?.provider_payload || error, String(error || ""));
  const status = Number(error?.status || 0);
  if (/pixazo/i.test(raw) && (status === 401 || status === 403 || /\b(401|403)\b|unauthorized|forbidden|subscription/i.test(raw))) {
    return {
      code: "PIXAZO_ACCESS_DENIED",
      userMessage: "Pixazo 试衣接口拒绝访问。",
      suggestion: "系统已尝试 Pixazo 主网关和备用网关。请在 Pixazo 后台确认这个 API Key 已开通 IDM/DM-VTON 接口权限且余额可用；如果后台显示已开通，再检查传给 Pixazo 的服装图和模特图是否为无登录、无防盗链的公网 URL。",
      providerMessage: raw
    };
  }
  if (/pixazo/i.test(raw) && /fetch failed|network failed|getaddrinfo|enotfound|eai_again|dns|network/i.test(raw)) {
    return {
      code: "PIXAZO_NETWORK_UNREACHABLE",
      userMessage: "后端无法连接 Pixazo 试衣网关。",
      suggestion: "系统已尝试 Pixazo 主网关和备用网关；请检查本机网络/DNS 是否能访问 gateway.pixazo.ai 或 gateway.appypie.com。如果国内网络不通，建议暂时切回百炼 AI 试衣 Plus，或让 Pixazo 提供国内可访问的网关域名。",
      providerMessage: raw
    };
  }
  if (/302\.AI FASHN|FASHN Try-On/i.test(raw) && /fetch failed|network failed|getaddrinfo|enotfound|eai_again|dns|network/i.test(raw)) {
    return {
      code: "THREE_O_TWO_FASHN_NETWORK_UNREACHABLE",
      userMessage: "后端无法连接 302.AI FASHN 试衣接口。",
      suggestion: "请稍后重试，或临时切换到百炼 AI 试衣 Plus/Pixazo 备选模型。系统已调整为：如果前面已生成过候选图，后续重试网络失败不会再把整单直接打失败。",
      providerMessage: raw
    };
  }
  if (/302\.AI FASHN|FASHN Try-On/i.test(raw) && (status === 401 || status === 403 || /\b(401|403)\b|unauthorized|forbidden|access denied|permission/i.test(raw))) {
    return {
      code: "THREE_O_TWO_FASHN_ACCESS_DENIED",
      userMessage: "302.AI FASHN 试衣接口拒绝访问。",
      suggestion: "请检查 302.AI Key 是否仍有效、余额是否可用、账号是否已开通 FASHN Try-On；如果权限正常，再确认上传到 OSS 的模特图和服装图是可公网访问的 URL。",
      providerMessage: raw
    };
  }
  if (/input\.category|category must be one of|upper_body|lower_body|dresses/i.test(raw)) {
    return {
      code: "TRYON_CATEGORY_INVALID",
      userMessage: "试衣模型品类参数不符合要求。",
      suggestion: "系统已修正 FASHN 品类映射：上衣 upper_body、下装 lower_body、连衣裙 dresses。请重启后端后重新提交任务。",
      providerMessage: raw
    };
  }
  if (status === 402 || /\b402\b|payment required|insufficient.*credit|billing|payment|quota|balance/i.test(raw)) {
    return {
      code: "PROVIDER_BILLING_OR_QUOTA_REQUIRED",
      userMessage: "模型供应商账号额度或计费状态不可用。",
      suggestion: "请检查 Replicate 账号是否已开通计费、余额是否充足、Token 是否属于已开通计费的账号；处理完成后重新提交任务，或先切换回百炼 AI 试衣 Plus。",
      providerMessage: raw
    };
  }
  if (/content checker|flagged by a content checker|内容检查器|inappropriate content|data_inspection_failed|sensitive|content/i.test(raw)) {
    const isFashn = /302\.AI FASHN|FASHN Try-On/i.test(raw);
    return {
      code: "CONTENT_REJECTED",
      userMessage: `输入图片触发${isFashn ? "302.AI/FASHN" : "模型供应商"}内容安全拦截，未生成。`,
      suggestion: "请更换更规范的真人模特图和服装图：真人模特建议使用正面全身站姿、非暴露、非内衣/泳装、背景简单；服装图建议使用平铺或假人展示、无真人裸露皮肤、无水印和敏感文字。",
      providerMessage: raw
    };
  }
  if (/authorization to access the media resource|access.*media resource|403|forbidden|accessdenied|access denied/i.test(raw)) {
    return {
      code: "MEDIA_ACCESS_DENIED",
      userMessage: "百炼无法读取 OSS 图片资源。",
      suggestion: "请把 OSS 上传对象设置为 public-read，或提供不带签名参数的公网图片 URL；然后重新上传服装图和真人模特图再生成。",
      providerMessage: raw
    };
  }
  if (/image resolution is invalid|largest length.*4096|size of image ranges from 5kb to 5mb|5kb to 5mb/i.test(raw)) {
    return {
      code: "IMAGE_DIMENSION_OR_SIZE_INVALID",
      userMessage: "输入图片不符合百炼模型尺寸或大小要求。",
      suggestion: "请重新上传服装图和真人模特图。系统会自动生成 5KB-5MB、最长边小于 4096px、最短边大于 150px 的模型合规图；如果使用旧模特库图片，请在模特库中点击修改并重新上传该模特图。",
      providerMessage: raw
    };
  }
  if (/公网|HTTP\/HTTPS|public|data url|image url/i.test(raw)) {
    return {
      code: "IMAGE_URL_INVALID",
      userMessage: "模型无法读取输入图片 URL。",
      suggestion: "请确认服装图和真人模特图均已成功上传 OSS，并且生成的是可公网访问的签名 URL。",
      providerMessage: raw
    };
  }
  if (/timeout|timed out|aborted|aborterror|operation was aborted/i.test(raw)) {
    return {
      code: "PROVIDER_ABORTED_OR_TIMEOUT",
      userMessage: "模型调用被中断或响应超时。",
      suggestion: "请稍后重试；如果连续出现，可先减少生成张数、暂时关闭最终商用出图，或检查百炼/302.ai 当前响应是否较慢。",
      providerMessage: raw
    };
  }
  return {
    code: "PROVIDER_ERROR",
    userMessage: "模型供应商返回错误。",
    suggestion: "请检查输入图片是否清晰、是否符合平台规则；如果连续失败，请切换图片或稍后再试。",
    providerMessage: raw
  };
}

async function createImageCandidate(store, task, index, context, imageCount, baseProgress, attempt, maxAttempts) {
  task.stage_timings[`candidate_${index}_attempt_${attempt}`] = {
    started_at: now(),
    max_attempts: maxAttempts
  };
  const selectedTryonModel = String(task.params?.image?.tryon_model || "").toLowerCase();
  const isGptImageTryon = selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image:tryon" || selectedTryonModel === "gpt-image";
  if (!isGptImageTryon && task.params?.pre_edit?.enabled !== false) {
    updateTaskStage(store, task, "pre_editing", clamp(Math.max(20, baseProgress), 1, 98), `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在做试衣前素材改图`);
  }
  updateTaskStage(store, task, "virtual_tryon", clamp(Math.max(36, baseProgress + 8), 1, 98), `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在虚拟试衣中`);
  let aiResult = await generateTryOnImage(task, context, index);
  let effectValidation = aiResult.model_meta?.tryon_effect_validation || null;
  try {
    if (!effectValidation) {
      updateTaskStage(store, task, "effect_validating", task.active_progress.validate, `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在检查商品一致性`);
      effectValidation = await validateTryOnEffectWithVision({ task, context, aiResult });
    }
    if (effectValidation && !aiResult.model_meta?.tryon_effect_validation) {
      aiResult = {
        ...aiResult,
        model_meta: {
          ...(aiResult.model_meta || {}),
          tryon_effect_validator: effectValidation.model,
          tryon_effect_validation: effectValidation
        }
      };
    }
    if (effectValidation) task.stage_timings[`tryon_effect_validate_${index}_attempt_${attempt}`] = effectValidation;
  } catch (error) {
    task.stage_timings[`tryon_effect_validate_${index}_attempt_${attempt}_error`] = {
      error: error?.message || String(error),
      at: now()
    };
  }

  if (validationFailed(effectValidation)) {
    task.stage_timings[`downstream_models_${index}_attempt_${attempt}_cancelled`] = {
      reason: "product_fidelity_or_tryon_effect_failed",
      cancelled: ["tryon_refiner", "final_commercial_retouch"],
      validation: effectValidation,
      at: now()
    };
    return {
      ...aiResult,
      model_meta: {
        ...(aiResult.model_meta || {}),
        openai_image_optimizer_skipped: true,
        openai_image_optimizer_skip_reason: "商品一致性或试衣生效质检未通过，后续大模型环节已取消。"
      }
    };
  }

  try {
    const tryOnPassedResult = {
      ...aiResult,
      model_meta: {
        ...(aiResult.model_meta || {}),
        tryon_effect_validator: effectValidation?.model || aiResult.model_meta?.tryon_effect_validator,
        tryon_effect_validation: effectValidation || aiResult.model_meta?.tryon_effect_validation
      }
    };
    aiResult = await optimizeImageWithOpenAI(task, context, aiResult, index);
    updateTaskStage(store, task, "effect_validating", task.active_progress.validate, `第 ${index + 1}/${imageCount} 张，第 ${attempt}/${maxAttempts} 次：正在复核最终商品一致性`);
    const finalValidation = await validateTryOnEffectWithVision({ task, context, aiResult });
    if (finalValidation) {
      task.stage_timings[`final_product_fidelity_validate_${index}_attempt_${attempt}`] = finalValidation;
      if (validationFailed(finalValidation)) {
        task.stage_timings[`final_commercial_output_${index}_attempt_${attempt}_rejected`] = {
          reason: finalValidation.reason || "最终商用出图改变了目标服装",
          issue_tags: finalValidation.issue_tags || [],
          rejected_image_url: aiResult.image_url || aiResult.cover_url,
          fallback_image_url: tryOnPassedResult.image_url || tryOnPassedResult.cover_url,
          at: now()
        };
        return {
          ...tryOnPassedResult,
          model_meta: {
            ...(tryOnPassedResult.model_meta || {}),
            final_product_fidelity_validation: finalValidation,
            openai_image_optimizer_rejected: true,
            openai_image_optimizer_rejected_reason: finalValidation.reason || "最终商用出图改变了目标服装，已自动回退到试衣精修图。",
            openai_image_optimizer_rejected_issue_tags: finalValidation.issue_tags || [],
            openai_image_optimizer_fallback_url: tryOnPassedResult.image_url || tryOnPassedResult.cover_url
          }
        };
      }
      aiResult = {
        ...aiResult,
        model_meta: {
          ...(aiResult.model_meta || {}),
          tryon_effect_validator: finalValidation.model,
          tryon_effect_validation: finalValidation,
          final_product_fidelity_validation: finalValidation
        }
      };
    }
  } catch (error) {
    task.stage_timings[`openai_image_optimize_${index}_attempt_${attempt}_error`] = {
      error: error?.message || String(error),
      at: now()
    };
    aiResult = {
      ...aiResult,
      model_meta: {
        ...(aiResult.model_meta || {}),
        openai_image_optimizer_skipped: true,
        openai_image_optimizer_error: error?.message || String(error)
      }
    };
  }
  return aiResult;
}

async function createResult(store, task, mediaType, index, context) {
  const imageCount = Math.max(1, Number(task.params?.image?.count || 1));
  const baseProgress = Math.min(92, 18 + Math.round((index / imageCount) * 68));
  Object.defineProperties(task, {
    active_generation_index: { value: index, writable: true, configurable: true, enumerable: false },
    active_generation_count: { value: imageCount, writable: true, configurable: true, enumerable: false },
    active_progress: {
      value: {
        preEdit: clamp(Math.max(20, baseProgress), 1, 98),
        tryon: clamp(Math.max(36, baseProgress + 8), 1, 98),
        refine: clamp(Math.max(58, baseProgress + 18), 1, 98),
        validate: clamp(Math.max(72, baseProgress + 28), 1, 98),
        gpt: clamp(Math.max(84, baseProgress + 36), 1, 98),
        score: clamp(Math.max(92, baseProgress + 42), 1, 98)
      },
      writable: true,
      configurable: true,
      enumerable: false
    },
    reportStage: { value: (status, progress, message) => updateTaskStage(store, task, status, progress, message), writable: true, configurable: true, enumerable: false }
  });
  let aiResult;
  if (mediaType === "image") {
    const maxRetries = Math.max(0, Number(process.env.PRODUCT_FIDELITY_MAX_RETRIES || 3));
    const maxAttempts = maxRetries + 1;
    let lastCandidate = null;
    let lastValidation = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        aiResult = await createImageCandidate(store, task, index, context, imageCount, baseProgress, attempt, maxAttempts);
        lastCandidate = aiResult;
      } catch (error) {
        task.stage_timings[`candidate_${index}_attempt_${attempt}_error`] = {
          error: error?.message || String(error),
          at: now()
        };
        if (!lastCandidate) throw error;
        aiResult = {
          ...lastCandidate,
          model_meta: {
            ...(lastCandidate.model_meta || {}),
            product_fidelity_attempts: attempt - 1,
            product_fidelity_max_attempts: maxAttempts,
            product_fidelity_max_retries: maxRetries,
            product_fidelity_retry_exhausted: true,
            product_fidelity_provider_error_after_candidate: error?.message || String(error),
            product_fidelity_retry_reason: `后续自动重试调用失败，已保留上一张候选图：${lastValidation?.reason || "商品一致性未通过"}`
          }
        };
        break;
      }
      const validation = aiResult.model_meta?.tryon_effect_validation;
      lastValidation = validation || lastValidation;
      if (!validationFailed(validation)) {
        aiResult.model_meta = {
          ...(aiResult.model_meta || {}),
          product_fidelity_attempts: attempt,
          product_fidelity_max_attempts: maxAttempts,
          product_fidelity_max_retries: maxRetries
        };
        break;
      }
      task.stage_timings[`product_fidelity_retry_${index}_${attempt}`] = {
        reason: validation?.reason || "商品一致性未通过",
        issue_tags: validation?.issue_tags || [],
        at: now()
      };
      if (attempt < maxAttempts) {
        task.active_retry_feedback = [
          validation?.reason || "",
          ...(validation?.issue_tags || [])
        ].filter(Boolean).join("；") || "颜色、衣长比例或纹理细节与原图不一致";
        updateTaskStage(store, task, "virtual_tryon", clamp(Math.max(36, baseProgress + 8), 1, 98), `第 ${index + 1}/${imageCount} 张商品一致性未通过，正在自动重试 ${attempt + 1}/${maxAttempts}`);
      } else {
        aiResult.model_meta = {
          ...(aiResult.model_meta || {}),
          product_fidelity_attempts: attempt,
          product_fidelity_max_attempts: maxAttempts,
          product_fidelity_max_retries: maxRetries,
          product_fidelity_retry_exhausted: true,
          product_fidelity_retry_reason: `已自动重新生成 ${maxRetries} 次仍未通过：${validation?.reason || "颜色、版型比例/衣长或装饰纹理与原图不一致"}`
        };
      }
    }
    task.active_retry_feedback = null;
    updateTaskStage(store, task, "quality_scoring", task.active_progress.score, `第 ${index + 1}/${imageCount} 张：正在进行商用品质评分`);
  } else {
    aiResult = await generateTryOnVideo(task, context, index);
  }
  const quality = scoreCommercialQuality({ task, context, aiResult, mediaType, index });
  const result = {
    id: id("result"),
    task_id: task.id,
    media_type: mediaType,
    image_url: mediaType === "image" ? aiResult.image_url : null,
    video_url: mediaType === "video" ? aiResult.video_url : null,
    cover_url: aiResult.cover_url || `/v1/media/results/${task.id}/${index}.svg?cover=1`,
    duration_seconds: mediaType === "video" ? Number(aiResult.duration_seconds || task.params?.video?.duration_seconds || 15) : null,
    score: quality.overall_score,
    quality_status: quality.quality_status,
    issue_tags: quality.issue_tags,
    quality_report: quality.report,
    hd_status: quality.hd_status,
    download_allowed: quality.download_allowed,
    model_meta: {
      ...(aiResult.model_meta || {}),
      provider: aiResult.provider || "mock",
      qc_model: "commercial-quality-rule-v1.0.1",
      quality_strategy: task.params?.quality_strategy || "commercial"
    },
    created_at: now()
  };
  store.results.push(result);
  return result;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scoreCommercialQuality({ task, context, aiResult, mediaType, index }) {
  const provider = aiResult.provider || "mock";
  const imageModel = aiResult.model_meta?.image_model || aiResult.model_meta?.video_model || "";
  const strategy = task.params?.quality_strategy || "commercial";
  const garmentRisks = context.garment?.risk_flags || [];
  const modelRisks = context.model?.risk_flags || [];
  const effectValidation = aiResult.model_meta?.tryon_effect_validation;
  const effectFailed = validationFailed(effectValidation);
  const retryExhausted = Boolean(aiResult.model_meta?.product_fidelity_retry_exhausted);
  const finalOptimizeRequested = mediaType === "image" && task.params?.post_optimize?.enabled === true;
  const finalOptimizeFailed = finalOptimizeRequested && Boolean(
    aiResult.model_meta?.openai_image_optimizer_error ||
    aiResult.model_meta?.openai_image_optimizer_rejected ||
    (
      aiResult.model_meta?.openai_image_optimizer_skipped &&
      !aiResult.model_meta?.openai_image_optimizer
    )
  );
  const riskPenalty = [...garmentRisks, ...modelRisks].reduce((sum, item) => sum + (item.level === "block" ? 22 : item.level === "warn" ? 6 : 2), 0);
  let base = mediaType === "video" ? 76 : 78;
  if (provider === "aliyun") base += 8;
  if (/aitryon-plus/i.test(imageModel)) base += 4;
  if (/refiner/i.test(imageModel)) base += 6;
  if (task.params?.pre_edit?.enabled === true && task.params?.pre_edit?.prompt) base += 2;
  if (strategy === "studio") base += 4;
  if (strategy === "preview") base -= 7;
  if (effectFailed || retryExhausted) base -= 38;
  if (finalOptimizeFailed) base -= 22;
  base -= index * 4;
  base -= Math.min(18, riskPenalty);

  const garmentNaturalness = clamp(base + (index === 2 ? -14 : 0), 35, 96);
  const garmentConsistency = clamp(base + (/qwen-image-edit-max|qwen-image-2.0-pro/i.test(task.params?.pre_edit?.model || "") ? 3 : 0) - (index === 3 ? 7 : 0), 35, 96);
  const clarity = clamp(base + (/refiner/i.test(imageModel) ? 5 : -4) + (Number(process.env.ALIYUN_TRYON_RESOLUTION || 1280) >= 1280 ? 2 : -5), 35, 96);
  const bodyIntegrity = clamp(base - (context.model?.pose_type === "half_body" && context.garment?.category === "pants" ? 16 : 0), 35, 96);
  const backgroundQuality = clamp(base + 3, 40, 98);
  const overall = Math.round(
    garmentNaturalness * 0.35 +
    garmentConsistency * 0.30 +
    clarity * 0.20 +
    bodyIntegrity * 0.10 +
    backgroundQuality * 0.05
  );

  const issueTags = [];
  if (garmentNaturalness < 70) issueTags.push("服装变形风险");
  if (garmentConsistency < 70) issueTags.push("商品一致性不足");
  if (clarity < 70) issueTags.push("清晰度不足");
  if (bodyIntegrity < 70) issueTags.push("人体结构风险");
  if (effectFailed) {
    issueTags.push(effectValidation?.product_fidelity_passed === false ? "商品一致性不合格" : "试衣未明显生效");
    (effectValidation.issue_tags || []).slice(0, 2).forEach(tag => issueTags.push(tag));
  }
  if (retryExhausted) issueTags.push("已达最大重试次数");
  if (finalOptimizeFailed) issueTags.push("最终商用出图未完成");
  garmentRisks.concat(modelRisks).filter(item => item.level === "warn").slice(0, 2).forEach(item => issueTags.push(item.message));

  let qualityStatus = "unusable";
  if (overall >= 80 && garmentNaturalness >= 70 && garmentConsistency >= 70 && clarity >= 70) qualityStatus = "recommended";
  else if (overall >= 70) qualityStatus = "usable";
  else if (overall >= 55) qualityStatus = "repair_needed";
  if (effectFailed || retryExhausted) qualityStatus = "unusable";
  if (finalOptimizeFailed && qualityStatus === "recommended") qualityStatus = "repair_needed";

  return {
    overall_score: overall,
    quality_status: qualityStatus,
    issue_tags: issueTags,
    hd_status: qualityStatus === "recommended" ? "enhanced" : qualityStatus === "usable" ? "ready" : qualityStatus === "repair_needed" ? "needs_repair" : "not_allowed",
    download_allowed: ["recommended", "usable"].includes(qualityStatus),
    report: {
      overall_score: overall,
      garment_naturalness: garmentNaturalness,
      garment_consistency: garmentConsistency,
      clarity,
      body_integrity: bodyIntegrity,
      background_quality: backgroundQuality,
      tryon_effect_passed: effectValidation ? Boolean(effectValidation.passed) : null,
      tryon_effect_reason: effectValidation?.reason || null,
      color_match: effectValidation?.color_match ?? null,
      color_score: effectValidation?.color_score ?? null,
      shape_length_match: effectValidation?.shape_length_match ?? null,
      shape_length_score: effectValidation?.shape_length_score ?? null,
      detail_texture_match: effectValidation?.detail_texture_match ?? null,
      detail_texture_score: effectValidation?.detail_texture_score ?? null,
      product_fidelity_passed: effectValidation?.product_fidelity_passed ?? null,
      product_fidelity_attempts: aiResult.model_meta?.product_fidelity_attempts || 1,
      product_fidelity_max_attempts: aiResult.model_meta?.product_fidelity_max_attempts || (Number(process.env.PRODUCT_FIDELITY_MAX_RETRIES || 3) + 1),
      product_fidelity_max_retries: aiResult.model_meta?.product_fidelity_max_retries || Number(process.env.PRODUCT_FIDELITY_MAX_RETRIES || 3),
      product_fidelity_retry_exhausted: retryExhausted,
      final_commercial_output_failed: finalOptimizeFailed,
      commercial_grade: overall >= 90 ? "S" : overall >= 80 ? "A" : overall >= 70 ? "B" : overall >= 55 ? "C" : "D",
      decision: qualityStatus === "recommended" ? "recommend_for_commerce" : qualityStatus === "usable" ? "allow_basic_download" : qualityStatus === "repair_needed" ? "send_to_repair" : "reject_for_commerce"
    }
  };
}

async function settleTask(taskId) {
  const store = readStore();
  const task = store.tasks.find(item => item.id === taskId);
  if (!task || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return;

  const imageCount = task.output_type === "image" || task.output_type === "image_video" ? Number(task.params?.image?.count || 4) : 0;
  const hasVideo = task.output_type === "video" || task.output_type === "image_video";
  const garmentReferenceImages = normalizeGarmentReferenceImages(task.params?.garment_references);
  const garment = store.garments.find(item => item.id === task.garment_id);
  const context = {
    garment: garment ? { ...garment, reference_images: garmentReferenceImages } : garment,
    garmentReferences: garmentReferenceImages,
    model: findModelById(store, task.model_id),
    bestImageUrl: null
  };
  for (let i = 0; i < imageCount; i += 1) {
    const result = await createResult(store, task, "image", i, context);
    if (i === 0) context.bestImageUrl = result.image_url;
  }
  if (hasVideo) await createResult(store, task, "video", imageCount, context);

  const taskResults = store.results.filter(result => result.task_id === task.id);
  const recommended = taskResults.filter(result => result.quality_status === "recommended");
  const usable = taskResults.filter(result => result.quality_status === "usable");
  const repairNeeded = taskResults.filter(result => result.quality_status === "repair_needed");
  const unusable = taskResults.filter(result => result.quality_status === "unusable");
  const commercialPassed = recommended.length >= 1;

  task.status = "completed";
  task.progress = 100;
  task.current_stage = "completed";
  task.commercial_status = commercialPassed ? "passed" : "not_passed";
  task.quality_summary = {
    commercial_passed: commercialPassed,
    recommended_count: recommended.length,
    usable_count: usable.length,
    repair_needed_count: repairNeeded.length,
    unusable_count: unusable.length,
    best_score: taskResults.reduce((max, result) => Math.max(max, Number(result.score || 0)), 0)
  };
  task.message = commercialPassed ? "生成完成，已筛出可商用推荐图" : "生成完成，但未达到商用推荐门槛，建议更换素材或切换商拍增强";
  task.completed_at = now();
  task.stage_timings.completed_at = task.completed_at;
  addEvent(store, task.id, task.status, task.progress, task.message);

  const log = store.credit_logs.find(item => item.task_id === task.id && item.reason === "precharge");
  if (log) log.status = "settled";
  writeStore(store);
}

function scheduleTask(taskId) {
  const store = readStore();
  const task = store.tasks.find(item => item.id === taskId);
  if (!task) return;
  const flow = task.output_type === "video" ? STATUS_FLOW_VIDEO : task.output_type === "image_video" ? STATUS_FLOW_VIDEO : STATUS_FLOW_IMAGE;
  flow.forEach(([status, progress, message], index) => {
    setTimeout(() => {
      if (status === "completed") {
        settleTask(taskId).catch(error => {
          const current = readStore();
          const item = current.tasks.find(row => row.id === taskId);
          if (!item) return;
          const normalized = normalizeProviderError(error);
          item.status = "failed";
          item.progress = 100;
          item.current_stage = "failed";
          item.failure_reason = normalized.providerMessage;
          item.failure_detail = normalized;
          item.message = normalized.userMessage;
          addEvent(current, taskId, item.status, item.progress, `${normalized.userMessage} ${normalized.suggestion}`);
          writeStore(current);
        });
        return;
      }
      const current = readStore();
      const item = current.tasks.find(row => row.id === taskId);
      if (!item || item.status === "cancelled") return;
      item.status = status;
      item.progress = progress;
      item.current_stage = status;
      item.message = message;
      item.stage_timings[status] = now();
      addEvent(current, taskId, status, progress, message);
      writeStore(current);
    }, index * 1400 + 300);
  });
}

function svgForResult(taskId, index) {
  const store = readStore();
  const task = store.tasks.find(item => item.id === taskId);
  const garment = store.garments.find(item => item.id === task?.garment_id);
  const colors = ["#2563eb", "#0f766e", "#6d28d9", "#d97706", "#16a34a", "#dc2626"];
  const color = colors[index % colors.length];
  const title = garment?.category_label || "AI 试穿";
  const mediaText = task?.output_type === "video" ? "Video Cover" : "Try-on Result";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#e0f2fe"/>
    </linearGradient>
  </defs>
  <rect width="900" height="1200" fill="url(#bg)"/>
  <rect x="84" y="72" width="732" height="1056" rx="42" fill="#fff" stroke="#e4e7ec" stroke-width="3"/>
  <circle cx="450" cy="230" r="76" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="6"/>
  <path d="M280 1020 C300 700, 340 425, 450 425 C560 425, 600 700, 620 1020 Z" fill="${color}" opacity="0.92"/>
  <path d="M340 500 C380 560, 520 560, 560 500" fill="none" stroke="#fff" stroke-width="14" opacity="0.8"/>
  <path d="M310 680 L590 680 M300 790 L600 790 M315 900 L585 900" stroke="#fff" stroke-width="10" opacity="0.35"/>
  <text x="450" y="1090" text-anchor="middle" fill="#101828" font-size="38" font-family="Arial, sans-serif" font-weight="700">${title}</text>
  <text x="450" y="1140" text-anchor="middle" fill="#667085" font-size="24" font-family="Arial, sans-serif">${mediaText} ${index + 1}</text>
</svg>`;
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    send(res, 200, { status: "ok", service: "virtual-tryon-backend", time: now() });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/system/capabilities") {
    send(res, 200, { data: apiCapabilities() });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/models/system") {
    const store = readStore();
    send(res, 200, { data: modelLibrary(store) });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/models/system") {
    const body = await parseBody(req);
    const store = readStore();
    body.file = await normalizeUploadedFile(body.file, "models");
    const fileUrl = body.file?.url || body.file?.read_url || body.file?.data_url || body.file_url || null;
    if (!fileUrl) {
      send(res, 422, { error: "MODEL_IMAGE_REQUIRED", message: "新增模特需要上传真人/模特图片。" });
      return;
    }
    const risk_flags = riskFromFile({ ...(body.file || {}), expected_role: "model" });
    const model = {
      id: id("model"),
      tenant_id: "tenant-demo",
      user_id: "user-demo",
      source: "library_upload",
      ...normalizeModelPayload({ ...body, file_url: fileUrl, preview_url: fileUrl }),
      file_url: fileUrl,
      preview_url: fileUrl,
      size_bytes: Number(body.file?.size || 0),
      mime_type: body.file?.type || null,
      object_key: body.file?.object_key || null,
      risk_flags,
      created_at: now(),
      updated_at: now()
    };
    store.model_assets.push(model);
    writeStore(store);
    send(res, 201, { data: model });
    return;
  }

  const modelCrudMatch = pathname.match(/^\/v1\/models\/system\/([^/]+)$/);
  if (modelCrudMatch && req.method === "PUT") {
    const modelId = decodeURIComponent(modelCrudMatch[1]);
    const body = await parseBody(req);
    const store = readStore();
    const existing = findModelById(store, modelId);
    if (!existing) return notFound(res);
    body.file = await normalizeUploadedFile(body.file, "models");
    const fileUrl = body.file?.url || body.file?.read_url || body.file?.data_url || body.file_url || existing.file_url || null;
    const fields = normalizeModelPayload({ ...body, file_url: fileUrl, preview_url: fileUrl }, existing);
    if (existing.source === "system") {
      const previous = store.model_library_changes.find(item => item.id === modelId);
      if (previous) {
        previous.deleted = false;
        previous.fields = fields;
        previous.updated_at = now();
      } else {
        store.model_library_changes.push({ id: modelId, deleted: false, fields, updated_at: now() });
      }
    } else {
      const index = store.model_assets.findIndex(item => item.id === modelId);
      if (index === -1) return notFound(res);
      store.model_assets[index] = {
        ...store.model_assets[index],
        ...fields,
        file_url: fileUrl,
        preview_url: fileUrl,
        size_bytes: Number(body.file?.size || store.model_assets[index].size_bytes || 0),
        mime_type: body.file?.type || store.model_assets[index].mime_type || null,
        object_key: body.file?.object_key || store.model_assets[index].object_key || null,
        risk_flags: body.file ? riskFromFile({ ...body.file, expected_role: "model" }) : store.model_assets[index].risk_flags || [],
        updated_at: now()
      };
    }
    writeStore(store);
    send(res, 200, { data: findModelById(store, modelId) });
    return;
  }

  if (modelCrudMatch && req.method === "DELETE") {
    const modelId = decodeURIComponent(modelCrudMatch[1]);
    const store = readStore();
    const existing = findModelById(store, modelId);
    if (!existing) return notFound(res);
    const activeTask = store.tasks.find(task => task.model_id === modelId && !["completed", "partial_failed", "failed", "cancelled"].includes(task.status));
    if (activeTask) {
      send(res, 409, { error: "MODEL_IN_USE", message: "该模特有处理中的任务，暂不能移除。" });
      return;
    }
    if (existing.source === "system") {
      const previous = store.model_library_changes.find(item => item.id === modelId);
      if (previous) {
        previous.deleted = true;
        previous.updated_at = now();
      } else {
        store.model_library_changes.push({ id: modelId, deleted: true, fields: {}, updated_at: now() });
      }
    } else {
      const index = store.model_assets.findIndex(item => item.id === modelId);
      if (index === -1) return notFound(res);
      store.model_assets[index].deleted_at = now();
    }
    if (store.model_assets.filter(item => !item.deleted_at).length === 0 && modelLibrary(store).length === 0) {
      send(res, 409, { error: "LAST_MODEL_NOT_REMOVABLE", message: "至少需要保留一个可用模特。" });
      return;
    }
    writeStore(store);
    send(res, 200, { data: { id: modelId, deleted: true } });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/credits/balance") {
    const store = readStore();
    send(res, 200, { data: { balance: store.users[0].credit_balance, currency: "credits" } });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/credits/logs") {
    const store = readStore();
    send(res, 200, { data: store.credit_logs.slice().reverse() });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/assets/upload-token") {
    const body = await parseBody(req);
    const token = oss.createUploadToken({
      fileName: body.file_name,
      contentType: body.content_type || body.mime_type || "application/octet-stream",
      folder: body.asset_type === "model" ? "models" : "uploads"
    });
    if (token) {
      send(res, 200, { data: token });
      return;
    }
    send(res, 200, {
      data: {
        upload_id: id("upload"),
        method: "demo-local-json",
        object_key: `tenant-demo/uploads/${Date.now()}-${body.file_name || "asset"}`,
        expires_in: 1800
      }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/assets/upload-data-url") {
    try {
      const body = await parseBody(req);
      const token = await oss.uploadDataUrl({
        dataUrl: body.data_url,
        fileName: body.file_name,
        folder: body.asset_type === "model" ? "models" : "uploads"
      });
      if (!token) {
        send(res, 503, { error: "OSS_NOT_CONFIGURED", message: "OSS 未配置，无法上传。" });
        return;
      }
      send(res, 200, { data: token });
    } catch (error) {
      send(res, 502, {
        error: "OSS_UPLOAD_FAILED",
        message: `OSS 上传失败：${error.message}`,
        detail: {
          suggestion: "请确认 OSS AccessKey 权限包含 PutObject，并且 Bucket 名称、Endpoint、地域配置正确。"
        }
      });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/v1/garments/analyze") {
    const body = await parseBody(req);
    body.file = await normalizeUploadedFile(body.file, "uploads");
    const store = readStore();
    const fallbackInferred = inferGarment(body.file?.name, body.description);
    let classifier = null;
    try {
      classifier = await classifyGarmentImage({
        imageUrl: body.file?.url || body.file?.read_url || body.file?.data_url,
        fileName: body.file?.name,
        description: body.description
      });
    } catch (error) {
      classifier = {
        ...fallbackInferred,
        confidence: 0,
        source: "fallback",
        reason: `模型识别暂不可用，已使用文件名/文本兜底：${error.message}`
      };
    }
    const inferred = classifier && classifier.confidence >= 0.55 ? classifier : fallbackInferred;
    const risk_flags = riskFromFile(body.file);
    if (classifier?.fashn_input_risk === "high") {
      risk_flags.push({
        code: "fashn_input_high_risk",
        level: "warn",
        message: `FASHN 输入风险较高：${classifier.fashn_risk_reason || "建议使用平铺、衣架或假人商品图。"}`
      });
    } else if (classifier?.fashn_input_risk === "medium") {
      risk_flags.push({
        code: "fashn_input_medium_risk",
        level: "warn",
        message: `FASHN 输入存在一定风险：${classifier.fashn_risk_reason || "如果生成失败，请改用更干净的商品图。"}`
      });
    }
    const garment = {
      id: id("garment"),
      tenant_id: "tenant-demo",
      user_id: "user-demo",
      file_name: body.file?.name || "demo-garment.png",
      file_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
      preview_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
      size_bytes: Number(body.file?.size || 0),
      mime_type: body.file?.type || null,
      object_key: body.file?.object_key || null,
      category: inferred.category,
      category_label: inferred.label,
      category_key: inferred.key,
      tryon_slot: inferred.tryon_slot,
      requires_full_body: Boolean(inferred.requires_full_body),
      color: body.color || "自动识别",
      material: body.material || "混纺/未知",
      pattern: body.pattern || "纯色或轻微图案",
      length: inferred.length,
      risk_flags,
      analysis: {
        clarity: risk_flags.some(item => item.code === "low_resolution") ? "low" : "good",
        subject_integrity: "passed",
        sensitive_content: "passed",
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
    store.garments.push(garment);
    writeStore(store);
    send(res, 200, { data: garment });
    return;
  }

  if (req.method === "PUT" && pathname.match(/^\/v1\/garments\/[^/]+\/category$/)) {
    const garmentId = decodeURIComponent(pathname.split("/")[3]);
    const body = await parseBody(req);
    const store = readStore();
    const garment = store.garments.find(item => item.id === garmentId);
    if (!garment) {
      send(res, 404, { error: "GARMENT_NOT_FOUND", message: "服装图不存在" });
      return;
    }
    const normalized = normalizeGarmentCategory(body.category_key || body.category, garment);
    garment.category = normalized.category;
    garment.category_label = normalized.label;
    garment.category_key = normalized.key;
    garment.length = normalized.length;
    garment.tryon_slot = normalized.tryon_slot;
    garment.requires_full_body = Boolean(normalized.requires_full_body);
    garment.analysis = {
      ...(garment.analysis || {}),
      category_source: "user_confirmed",
      category_confidence: 1,
      category_reason: "用户在页面二次确认服装品类。"
    };
    garment.updated_at = now();
    writeStore(store);
    send(res, 200, { data: garment });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/models/validate") {
    const body = await parseBody(req);
    body.file = await normalizeUploadedFile(body.file, "models");
    const store = readStore();
    let model;
    if (body.model_id) {
      model = findModelById(store, body.model_id);
    } else {
      model = {
        id: id("model"),
        name: body.file?.name || "用户上传模特",
        source: "user_upload",
        gender: "unknown",
        body_type: "regular",
        pose_type: "full_body_standing",
        file_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
        preview_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
        size_bytes: Number(body.file?.size || 0),
        mime_type: body.file?.type || null,
        object_key: body.file?.object_key || null,
        preview_color: "#0f766e",
        risk_flags: riskFromFile(body.file)
      };
      store.model_assets.push({ ...model, tenant_id: "tenant-demo", user_id: "user-demo", created_at: now() });
      writeStore(store);
    }
    if (!model) {
      send(res, 404, { error: "MODEL_NOT_FOUND", message: "模特不存在" });
      return;
    }
    send(res, 200, { data: { ...model, validation: { person: "passed", pose: "passed", sensitive_content: "passed" } } });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/agent/recommendations") {
    const body = await parseBody(req);
    const store = readStore();
    const garment = store.garments.find(item => item.id === body.garment_id) || inferGarment("", body.intent);
    const model = findModelById(store, body.model_id) || modelLibrary(store)[0];
    send(res, 200, { data: recommendParams({ garment, model, intent: body.intent, platform: body.platform_use }) });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/tryon/tasks") {
    const body = await parseBody(req);
    const store = readStore();
    const user = store.users[0];
    const garment = store.garments.find(item => item.id === body.garment_id);
    const model = findModelById(store, body.model_id);
    const outputType = body.output_type || "image";
    const needsImageTryon = outputType === "image" || outputType === "image_video";
    const rawParams = body.params || {};
    const rawGarmentReferences = Array.isArray(rawParams.garment_references) ? rawParams.garment_references : [];
    if (rawGarmentReferences.length > MAX_GARMENT_REFERENCE_IMAGES) {
      send(res, 422, {
        error: "GARMENT_REFERENCE_LIMIT_EXCEEDED",
        message: `服装细节参考图最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张，任务未提交，未扣额度。`,
        detail: {
          code: "GARMENT_REFERENCE_LIMIT_EXCEEDED",
          userMessage: "服装细节参考图数量超过上限。",
          suggestion: `请保留最关键的背面、Logo、印花、面料、领口、袖口等参考图，最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张。`
        }
      });
      return;
    }
    const params = {
      ...rawParams,
      garment_references: normalizeGarmentReferenceImages(rawGarmentReferences)
    };
    const selectedTryonModel = params?.image?.tryon_model || "";
    if (needsImageTryon && (selectedTryonModel === "aliyun:aitryon-plus" || (process.env.AI_IMAGE_PROVIDER || "").toLowerCase() === "aliyun")) {
      const validationErrors = validateAliyunTryonInputs({ garment, model });
      if (validationErrors.length) {
        send(res, 422, {
          error: "ALIYUN_TRYON_INPUT_INVALID",
          message: validationErrors.join(" "),
          detail: {
            code: "ALIYUN_TRYON_INPUT_INVALID",
            userMessage: "百炼试衣输入不符合要求，任务未提交，未扣额度。",
            suggestion: "请上传 5KB-20MB 的服装平铺图，以及 5KB-20MB 的正面全身真人模特图；两张图都需要成功上传 OSS。",
            validation_errors: validationErrors
          }
        });
        return;
      }
    }
    if (needsImageTryon && selectedTryonModel === "replicate:idm-vton" && !process.env.REPLICATE_API_TOKEN) {
      send(res, 422, {
        error: "REPLICATE_TOKEN_MISSING",
        message: "未配置 Replicate API Token，无法使用 IDM-VTON。",
        detail: {
          code: "REPLICATE_TOKEN_MISSING",
          userMessage: "IDM-VTON 未配置 API Token，任务未提交，未扣额度。",
          suggestion: "请在 .env 中配置 REPLICATE_API_TOKEN 后重启后端，或切换回百炼 AI 试衣 Plus。"
        }
      });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "pixelcut:try-on" || selectedTryonModel === "pixelcut:tryon" || selectedTryonModel === "pixelcut") && !process.env.PIXELCUT_API_KEY) {
      send(res, 422, {
        error: "PIXELCUT_TOKEN_MISSING",
        message: "未配置 Pixelcut API Key，无法使用 Pixelcut Try-On。",
        detail: {
          code: "PIXELCUT_TOKEN_MISSING",
          userMessage: "Pixelcut Try-On 未配置 API Key，任务未提交，未扣额度。",
          suggestion: "请在 .env 中配置 PIXELCUT_API_KEY 后重启后端，或切换到百炼 AI 试衣 Plus。"
        }
      });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "302:fashn-tryon" || selectedTryonModel === "302:fashn-tryon-v1.5") && !(process.env.THREE_O_TWO_API_KEY || process.env.API_302_KEY || process.env.OPENAI_API_KEY)) {
      send(res, 422, {
        error: "THREE_O_TWO_TOKEN_MISSING",
        message: "未配置 302.AI API Key，无法使用 FASHN Try-On。",
        detail: {
          code: "THREE_O_TWO_TOKEN_MISSING",
          userMessage: "302.AI FASHN Try-On 未配置 API Key，任务未提交，未扣额度。",
          suggestion: "请在 .env 中配置 THREE_O_TWO_API_KEY，或复用已配置的 302.AI Key，然后重启后端。"
        }
      });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "302:fashn-tryon" || selectedTryonModel === "302:fashn-tryon-v1.5")) {
      const validationErrors = validateFashnTryonInputs({ garment, model });
      if (validationErrors.length) {
        send(res, 422, {
          error: "FASHN_INPUT_INVALID",
          message: validationErrors.join(" "),
          detail: {
            code: "FASHN_INPUT_INVALID",
            userMessage: "302.AI/FASHN 输入素材缺少必要信息，任务未提交，未扣额度。",
            suggestion: "请确认服装主图和真人模特图都已上传成功，并且都是可公网访问的 HTTP/HTTPS 图片 URL。",
            validation_errors: validationErrors
          }
        });
        return;
      }
    }
    if (needsImageTryon && (selectedTryonModel === "pixazo:fashn-vton" || selectedTryonModel === "pixazo:idm-vton" || selectedTryonModel === "pixazo:dm-vton") && !(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY)) {
      send(res, 422, {
        error: "PIXAZO_TOKEN_MISSING",
        message: "未配置 Pixazo API Key，无法使用 Pixazo VTON。",
        detail: {
          code: "PIXAZO_TOKEN_MISSING",
          userMessage: "Pixazo VTON 未配置 API Key，任务未提交，未扣额度。",
          suggestion: "请在 .env 中配置 PIXAZO_API_KEY 后重启后端，或先切换回百炼 AI 试衣 Plus。"
        }
      });
      return;
    }
    if (needsImageTryon && (selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image:tryon" || selectedTryonModel === "gpt-image")) {
      if (process.env.GPT_IMAGE_TRYON_ENABLED !== "true") {
        send(res, 422, {
          error: "GPT_IMAGE_TRYON_DISABLED",
          message: "GPT-Image 直接试衣功能未启用。",
          detail: {
            code: "GPT_IMAGE_TRYON_DISABLED",
            userMessage: "GPT-Image 直接试衣功能未启用，任务未提交，未扣额度。",
            suggestion: "请在 .env 中设置 GPT_IMAGE_TRYON_ENABLED=true 后重启后端。"
          }
        });
        return;
      }
      if (!process.env.OPENAI_API_KEY) {
        send(res, 422, {
          error: "OPENAI_API_KEY_MISSING",
          message: "未配置 OPENAI_API_KEY，无法使用 GPT-Image 直接试衣。",
          detail: {
            code: "OPENAI_API_KEY_MISSING",
            userMessage: "GPT-Image 直接试衣需要配置 OPENAI_API_KEY，任务未提交，未扣额度。",
            suggestion: "请在 .env 中配置 OPENAI_API_KEY 和 OPENAI_IMAGE_EDIT_URL 后重启后端。"
          }
        });
        return;
      }
    }
    const cost = creditCost({ ...body, params });
    if (user.credit_balance < cost) {
      send(res, 402, { error: "INSUFFICIENT_CREDITS", message: "额度不足，无法提交生成任务。" });
      return;
    }
    user.credit_balance -= cost;
    const task = {
      id: id("task"),
      tenant_id: "tenant-demo",
      user_id: "user-demo",
      garment_id: body.garment_id,
      model_id: body.model_id,
      output_type: body.output_type || "image",
      prompt: body.prompt || "",
      params,
      status: "pending",
      progress: 1,
      current_stage: "pending",
      message: "任务已提交",
      credit_cost: cost,
      failure_reason: null,
      stage_timings: { submitted_at: now() },
      created_at: now(),
      updated_at: now()
    };
    store.tasks.push(task);
    store.credit_logs.push({
      id: id("credit"),
      tenant_id: "tenant-demo",
      user_id: "user-demo",
      task_id: task.id,
      amount: -cost,
      direction: "debit",
      reason: "precharge",
      status: "reserved",
      created_at: now()
    });
    addEvent(store, task.id, task.status, task.progress, task.message);
    writeStore(store);
    scheduleTask(task.id);
    send(res, 201, { data: task });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/tryon/tasks") {
    const store = readStore();
    const tasks = store.tasks.slice().reverse().map(task => ({
      ...task,
      results: store.results.filter(result => result.task_id === task.id)
    }));
    send(res, 200, { data: tasks });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/tryon/results") {
    const store = readStore();
    const rows = store.results.slice().reverse().map(result => {
      const task = store.tasks.find(item => item.id === result.task_id);
      return {
        ...result,
        task: task ? {
          id: task.id,
          output_type: task.output_type,
          status: task.status,
          commercial_status: task.commercial_status || null,
          created_at: task.created_at,
          prompt: task.prompt
        } : null
      };
    });
    send(res, 200, { data: rows });
    return;
  }

  const taskMatch = pathname.match(/^\/v1\/tryon\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const store = readStore();
    const task = store.tasks.find(item => item.id === taskMatch[1]);
    if (!task) return notFound(res);
    send(res, 200, {
      data: {
        ...task,
        results: store.results.filter(result => result.task_id === task.id),
        events: store.events.filter(event => event.task_id === task.id)
      }
    });
    return;
  }

  const resultDownload = pathname.match(/^\/v1\/tryon\/results\/([^/]+)\/download$/);
  if (req.method === "GET" && resultDownload) {
    const store = readStore();
    const result = store.results.find(item => item.id === resultDownload[1]);
    if (!result) return notFound(res);
    if (result.quality_status === "failed" || result.download_allowed === false || ["repair_needed", "unusable"].includes(result.quality_status)) {
      send(res, 409, { error: "RESULT_NOT_DOWNLOADABLE", message: "该素材未达到下载门槛，请先修复或重新生成。" });
      return;
    }
    send(res, 200, {
      data: {
        signed_url: result.media_type === "image" ? result.image_url : result.video_url,
        expires_in: 1800,
        file_name: `${result.id}.${result.media_type === "image" ? "svg" : "mp4"}`
      }
    });
    return;
  }

  const mediaMatch = pathname.match(/^\/v1\/media\/results\/([^/]+)\/(\d+)\.(svg|mp4)$/);
  if (req.method === "GET" && mediaMatch) {
    const [, taskId, index, ext] = mediaMatch;
    if (ext === "svg") {
      sendText(res, 200, svgForResult(taskId, Number(index)), "image/svg+xml; charset=utf-8");
      return;
    }
    const body = "Demo MP4 placeholder. Replace Video Worker output with a real MP4 object URL in production.";
    sendText(res, 200, body, "video/mp4");
    return;
  }

  const generatedMatch = pathname.match(/^\/v1\/media\/generated\/([^/]+)$/);
  if (req.method === "GET" && generatedMatch) {
    const fileName = path.basename(generatedMatch[1]);
    const filePath = path.join(DATA_DIR, "generated", fileName);
    if (!filePath.startsWith(path.join(DATA_DIR, "generated")) || !fs.existsSync(filePath)) {
      return notFound(res);
    }
    const ext = path.extname(fileName).toLowerCase();
    const type = ext === ".png"
      ? "image/png"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".mp4"
          ? "video/mp4"
          : ext === ".webm"
            ? "video/webm"
            : "image/jpeg";
    res.writeHead(200, {
      "Content-Type": type,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  notFound(res);
}

ensureStore();
const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    send(res, 500, { error: "INTERNAL_ERROR", message: error.message || "服务异常" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Virtual Try-On backend is running at http://${HOST}:${PORT}`);
});
