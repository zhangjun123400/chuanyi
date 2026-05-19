const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const oss = require("../storage/oss");
const { MAX_IMAGE_UPLOAD_BYTES, PROVIDER_MAX_IMAGE_BYTES, PROVIDER_MIN_IMAGE_EDGE, PROVIDER_MAX_IMAGE_EDGE, MIN_IMAGE_UPLOAD_BYTES } = require("./constants");

const DATA_DIR = path.join(__dirname, "..", "..", "data");

const MAX_GARMENT_REFERENCE_IMAGES = 10;

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
  }
  if (file && Number(file.width || 0) > 0 && Number(file.height || 0) > 0 && Number(file.width || 1600) < 1024 && Number(file.height || 1600) < 1024) {
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

function saveDataUrlToLocal(dataUrl, fileName, folder = "uploads") {
  const parsed = oss.parseDataUrl(dataUrl);
  if (!parsed) return null;
  const dir = path.join(DATA_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = String(fileName || "asset").replace(/[^\w.\-一-龥]/g, "_");
  const ext = oss.extensionFromName(safeName, parsed.contentType);
  const outputName = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
  const outputPath = path.join(dir, outputName);
  fs.writeFileSync(outputPath, parsed.buffer);
  return {
    provider: "local",
    object_key: null,
    read_url: `/v1/media/${folder}/${outputName}`
  };
}

async function normalizeUploadedFile(file, folder) {
  if (!file) return file;
  if (file.url || file.read_url) return file;
  if (!file.data_url) return file;
  const result = saveDataUrlToLocal(file.data_url, file.name, folder);
  if (!result) return file;
  return { ...file, url: result.read_url, read_url: result.read_url, object_key: null };
}

module.exports = {
  GARMENT_CATEGORY_OPTIONS,
  normalizeGarmentCategory,
  inferGarment,
  riskFromFile,
  isRemoteUrl,
  normalizeGarmentReferenceImages,
  normalizeUploadedFile,
  saveDataUrlToLocal,
  MAX_GARMENT_REFERENCE_IMAGES,
  MAX_IMAGE_UPLOAD_BYTES,
  PROVIDER_MAX_IMAGE_BYTES,
  PROVIDER_MIN_IMAGE_EDGE,
  PROVIDER_MAX_IMAGE_EDGE,
  MIN_IMAGE_UPLOAD_BYTES
};
