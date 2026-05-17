// Agent: recommendations, credit cost, API capabilities
// Called by: server.js (refactored entry point)
// No existing file serves this purpose
// No data file read/write

const oss = require("../storage/oss");

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
  if (template === "轻微转身") risks.push("视频模板会进行帧一致性检查，复杂图案建议选择增强模式。");
  return {
    output_type: isVideo ? "image_video" : "image",
    image: { count: 4, ratio, background, keep_texture: true, quality_filter: true, platform_use: platform || "商品图" },
    video: { duration_seconds: isVideo ? 15 : 10, ratio: "9:16", motion_template: template, camera: garment.category === "shirt" ? "中景" : "中景全身", background, audio: "无", consistency: "标准" },
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
    pixazo_idm_vton_enabled: pixazoVtonEnabled, pixazo_fashn_vton_enabled: pixazoVtonEnabled,
    pixazo_idm_vton_endpoint: process.env.PIXAZO_IDM_VTON_URL || "https://gateway.pixazo.ai/idm-vton-api/v1/r-idm-vton",
    pixazo_fashn_vton_endpoint: process.env.PIXAZO_FASHN_VTON_URL || "https://gateway.pixazo.ai/fashn-virtual-try-on/v1/fashn-virtual-try-on-request",
    replicate_idm_vton_enabled: replicateIdmVtonEnabled,
    replicate_idm_vton_model: process.env.REPLICATE_IDM_VTON_MODEL || "cuuupid/idm-vton",
    tryon_resolution: Number(process.env.ALIYUN_TRYON_RESOLUTION || 1280),
    refiner_enabled: refinerEnabled,
    refiner_model: refinerEnabled ? process.env.ALIYUN_REFINER_MODEL || "aitryon-refiner" : null,
    pre_edit_enabled: preEditEnabled, pre_edit_default_enabled: false,
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
      { name: "GPT-Image 直接试衣", provider: imageOptimizerProvider, model: process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5", status: gptImageTryonEnabled ? "启用" : "待配置", purpose: "跳过传统VTON模型，直接用GPT-Image-1.5从模特+服装参考图生成逼真试衣图" },
      { name: "图片虚拟试衣", provider: imageProvider === "aliyun" ? "阿里云百炼" : imageProvider, model: imageProvider === "aliyun" ? process.env.ALIYUN_TRYON_MODEL || "aitryon-plus" : imageProvider, status: imageProvider === "mock" ? "模拟" : "启用", purpose: "把服装穿到真人模特身上，生成试衣候选图" },
      { name: "图片虚拟试衣主链路候选", provider: "Pixelcut", model: "Try-On API", status: pixelcutTryonEnabled ? "可选，当前优先测试" : "待配置", purpose: "通过 Pixelcut Try-On API 生成真人模特试衣图，用于替代 302.AI/FASHN 误杀链路" },
      { name: "图片虚拟试衣主链路", provider: "302.AI / FASHN", model: "FASHN Try-On v1.5", status: threeOhTwoFashnEnabled ? "可选" : "待配置", purpose: "302.AI 虚拟试衣" },
      { name: "图片虚拟试衣备选", provider: "Pixazo", model: "Fashn Virtual Try-On", status: pixazoVtonEnabled ? "可选" : "待配置", purpose: "Pixazo 虚拟试衣" },
      { name: "图片虚拟试衣备选", provider: "Replicate", model: process.env.REPLICATE_IDM_VTON_MODEL || "cuuupid/idm-vton", status: replicateIdmVtonEnabled ? "可选" : "待配置", purpose: "IDM-VTON 实验对比" },
      { name: "试衣图精修", provider: "阿里云百炼", model: process.env.ALIYUN_REFINER_MODEL || "aitryon-refiner", status: refinerEnabled ? "启用" : "关闭", purpose: "优化试衣图真实感" },
      { name: "试衣前图改图", provider: "阿里云百炼 / Qwen Image", model: process.env.ALIYUN_PRE_EDIT_MODEL || "qwen-image-edit-plus", status: preEditEnabled ? "可选" : "待配置", purpose: "保守预处理素材" },
      { name: "服装品类识别", provider: classifierProvider, model: process.env.GARMENT_CLASSIFIER_MODEL || "gpt-4o-mini", status: classifierEnabled ? "启用" : "待配置", purpose: "识别服装品类" },
      { name: "试衣生效质检", provider: classifierProvider, model: process.env.TRYON_EFFECT_VALIDATOR_MODEL || "gpt-4o", status: process.env.TRYON_EFFECT_VALIDATOR_ENABLED !== "false" && Boolean(process.env.OPENAI_API_KEY) ? "启用" : "待配置", purpose: "检查试衣是否生效" },
      { name: "最终商用出图", provider: imageOptimizerProvider, model: process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5", status: Boolean(process.env.OPENAI_API_KEY) ? "可选" : "待配置", purpose: "电商质感优化" },
      { name: "图生视频", provider: (process.env.AI_VIDEO_PROVIDER || "mock").toLowerCase() === "kling" ? "可灵 Kling" : (process.env.AI_VIDEO_PROVIDER || "mock"), model: process.env.KLING_VIDEO_MODEL || process.env.RUNWAY_VIDEO_MODEL || "mock-video", status: (process.env.AI_VIDEO_PROVIDER || "mock").toLowerCase() === "mock" ? "模拟" : "启用", purpose: "生成短视频展示" }
    ],
    commercial_quality: { recommended_threshold: 80, dimension_floor: 70, minimum_candidates: 4, required_recommended_count: 1, hd_target_long_edge: 2048 }
  };
}

module.exports = { recommendParams, creditCost, apiCapabilities };
