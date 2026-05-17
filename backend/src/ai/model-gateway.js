const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_TIMEOUT_MS = Number(process.env.AI_PROVIDER_TIMEOUT_MS || 300000);
const GENERATED_DIR = path.join(__dirname, "..", "..", "data", "generated");

function ensureGeneratedDir() {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reportTaskStage(task, status, progress, message) {
  if (typeof task?.reportStage === "function") {
    task.reportStage(status, progress, message);
  }
}

function stringifyProviderError(value, fallback = "AI provider returned an unknown error") {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  try {
    return JSON.stringify(value).slice(0, 1200);
  } catch {
    return String(value);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!res.ok) {
      const providerMessage = stringifyProviderError(
        payload.message || payload.error || payload.detail || payload.raw,
        `AI provider failed with ${res.status}`
      );
      const error = new Error(providerMessage);
      error.status = res.status;
      error.provider_payload = payload;
      error.response_body = text;
      throw error;
    }
    return payload;
  } catch (error) {
    if (timedOut || error?.name === "AbortError") {
      throw new Error(`AI provider request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRawWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const contentType = res.headers.get("content-type") || "";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!res.ok) {
      let message = buffer.toString("utf8");
      try {
        const parsed = JSON.parse(message);
        message = stringifyProviderError(parsed.message || parsed.error || parsed.detail || parsed, message);
      } catch {
        // Keep provider text as-is.
      }
      const error = new Error(message || `AI provider failed with ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return { contentType, buffer };
  } catch (error) {
    if (timedOut || error?.name === "AbortError") {
      throw new Error(`AI provider request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function saveProviderImage(task, index, buffer, contentType) {
  ensureGeneratedDir();
  const ext = contentType.includes("webp") ? "webp" : contentType.includes("png") ? "png" : "jpg";
  const fileName = `${task.id}-${index}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(GENERATED_DIR, fileName), buffer);
  return `/v1/media/generated/${fileName}`;
}

function saveProviderVideo(task, index, buffer, contentType) {
  ensureGeneratedDir();
  const ext = contentType.includes("webm") ? "webm" : "mp4";
  const fileName = `${task.id}-${index}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(GENERATED_DIR, fileName), buffer);
  return `/v1/media/generated/${fileName}`;
}

function mediaTypeFromFileName(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  return "image/jpeg";
}

function extensionFromContentType(contentType) {
  if (String(contentType || "").includes("png")) return "png";
  if (String(contentType || "").includes("webp")) return "webp";
  return "jpg";
}

function localMediaPathFromUrl(value) {
  if (typeof value !== "string") return null;
  const generatedPrefix = "/v1/media/generated/";
  if (value.startsWith(generatedPrefix)) {
    return path.join(GENERATED_DIR, path.basename(value));
  }
  return null;
}

function fileToDataUrl(filePath) {
  const contentType = mediaTypeFromFileName(filePath);
  const base64 = fs.readFileSync(filePath).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

async function downloadRemoteMediaToLocal(task, index, url, mediaType) {
  if (!isRemoteUrl(url)) return url;
  const { contentType, buffer } = await fetchRawWithTimeout(url, { method: "GET" }, DEFAULT_TIMEOUT_MS);
  if (mediaType === "video") return saveProviderVideo(task, index, buffer, contentType);
  return saveProviderImage(task, index, buffer, contentType);
}

function shouldOptimizeWithOpenAI(task) {
  const selectedTryonModel = String(task.params?.image?.tryon_model || "").toLowerCase();
  if (selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image:tryon" || selectedTryonModel === "gpt-image") {
    return false;
  }
  const taskSetting = task.params?.post_optimize?.enabled;
  return taskSetting === true && Boolean(process.env.OPENAI_API_KEY);
}

function productFidelityRulesText() {
  return [
    "【服装一致性铁律，优先级高于美化、清晰度、背景和任何运营要求】",
    "1. 衣服颜色必须和原图保持一致。",
    "2. 衣服三围比例和衣长必须按原图一比一还原。",
    "3. 衣服装饰细节和纹理必须和原图一致。",
    "如果这三项与美化发生冲突，必须牺牲美化，保留这三项一致性。"
  ].join("\n");
}

function garmentReferenceUrl(item) {
  return item?.file_url || item?.url || item?.read_url || item?.preview_url || item?.data_url || null;
}

function garmentReferenceInputs(context) {
  const inputs = [];
  const seen = new Set();
  const mainUrl = context.garment?.file_url || context.garment?.preview_url;
  if (mainUrl) {
    inputs.push({
      role: "front_main",
      name: "服装正面主图",
      url: mainUrl
    });
    seen.add(mainUrl);
  }
  const detailImages = Array.isArray(context.garmentReferences)
    ? context.garmentReferences
    : Array.isArray(context.garment?.reference_images)
      ? context.garment.reference_images
      : [];
  detailImages.slice(0, 10).forEach((item, index) => {
    const url = garmentReferenceUrl(item);
    if (!url || seen.has(url)) return;
    inputs.push({
      role: `detail_${index + 1}`,
      name: item?.name || `服装细节参考图${index + 1}`,
      url
    });
    seen.add(url);
  });
  return inputs;
}

function buildOpenAIOptimizationPrompt(task, context) {
  const userRequirement = String(task.params?.post_optimize?.prompt || "").trim();
  const imageParams = task.params?.image || {};
  const qualityStrategy = task.params?.quality_strategy || "commercial";
  const detailCount = Math.max(0, garmentReferenceInputs(context).length - 1);
  return [
    "你是服装电商商拍图片后期优化师。请基于输入的虚拟试衣结果图进行保守优化，目标是让图片达到服装电商详情图/主图可用水平。",
    "输入图片说明：第一张是虚拟试衣结果图，第二张是服装正面主图，后续图片如果存在则是服装背面、Logo、印花、面料、领口、袖口等细节参考图。",
    `本次额外细节参考图数量：${detailCount} 张。服装正面主图是版型、颜色和正面出图的第一真值；细节参考图用于理解背面结构、Logo、印花、面料纹理和工艺细节。`,
    "最终输出仍必须是正面模特试穿图。背面图只用于理解结构和材质，不要把背面元素错误画到正面。",
    "所有服装参考图共同构成商品真值，最终输出必须以它们作为不可违背的硬参考。",
    "本次任务不是重新设计服装，也不是生成相似风格服装；只能在不改变商品的前提下做清晰度、曝光、边缘和电商质感优化。",
    "必须保持真人模特身份、脸型、身材比例、姿态和服装穿着关系，不要换人，不要换衣，不要新增无关配饰。",
    "必须最大程度保留服装商品信息：颜色、版型、长度、领口、袖口、腰线、裙摆、裤腿、纽扣、Logo、花纹、纹理和材质都不能被重新设计。",
    productFidelityRulesText(),
    "重点优化：提升清晰度、面料纹理、边缘融合、曝光、白平衡、背景干净程度、主体居中和电商质感；轻微修复衣领、袖口、裙摆、裤腿边缘不自然问题。",
    "避免：低清、模糊、磨皮过度、五官变化、肢体变形、服装融化、图案漂移、颜色偏差、水印、文字、虚假吊牌。",
    `输出用途：${imageParams.platform_use || "商品图"}；背景要求：${imageParams.background || "干净棚拍"}；画幅：${imageParams.ratio || "9:16"}；品质链路：${qualityStrategy}。`,
    userRequirement ? `最终图片优化要求：${userRequirement}` : "",
    "输出一张真实自然、高清、无水印、可商用的服装试穿图。"
  ].filter(Boolean).join("\n");
}

function buildGptImageTryOnPrompt(task, context) {
  const imageParams = task.params?.image || {};
  const userRequirement = String(task.params?.image?.garment_description || "").trim();
  const detailCount = Math.max(0, garmentReferenceInputs(context).length - 1);
  return [
    "你是服装电商虚拟试衣摄影师。请根据输入图片生成一张模特穿着目标服装的照片级试穿图。",
    "第一张图片是真人模特原图（不可改变模特的任何特征）。",
    "后续图片是目标服装：第二张是服装正面主图（版型、颜色、正面出图的唯一真值），如果存在第三张及之后则是服装的背面、Logo、印花、面料、领口、袖口等细节参考图。",
    `本次目标服装细节参考图数量：${detailCount} 张。`,
    "",
    "【模特保留铁律 — 不可改变】",
    "1. 必须原样保留模特的面部五官、脸型、发型、发色和肤色。",
    "2. 必须原样保留模特的身体比例、体型、站姿、手势和手部形状。",
    "3. 必须原样保留原照片的背景场景、光照方向、光源颜色、阴影、相机角度和景深。",
    "4. 必须原样保留原照片的整体氛围和色调。",
    "",
    "【服装一致性铁律 — 目标服装是唯一真值，不是风格参考】",
    "1. 服装的颜色、面料光泽度必须和原服装图完全一致，不能偏浅、偏深或更改色相。",
    "2. 服装的三围比例、腰线位置、衣长/裙长/裤长必须和原服装图一比一还原。",
    "3. 服装的领型、袖型（长袖/短袖/无袖）、袖口形状、下摆形状和整体廓形必须和原服装图一致。",
    "4. 服装上的所有Logo、文字、印花图案、刺绣、蕾丝纹理、纽扣位置和形状、拉链、口袋位置和形状必须和原图完全一致，不允许重新设计或简化。",
    productFidelityRulesText(),
    "",
    "【禁止事项】",
    "1. 不要创造新的花纹、颜色或材质。",
    "2. 不要修改品牌Logo或文字内容。",
    "3. 不要重新设计服装版型或改变款型。",
    "4. 不要给模特添加或删除配饰。",
    "5. 不要把背面细节画到正面。背面图只用于理解结构和材质，不要把背面元素错误合并到正面。",
    "6. 不要改变模特的任何面部或身体特征。",
    "",
    "【输出要求】",
    "输出一张照片级真实、高清、无水印的电商服装试穿效果图。",
    "模特必须穿着目标服装，自然站立，正面完整展示服装。",
    "服装与模特身体的贴合必须自然真实，符合物理穿着的褶皱和垂坠感。",
    `画幅比例：${imageParams.ratio || "9:16"}；背景：${imageParams.background || "保留原背景"}。`,
    userRequirement ? `补充要求：${userRequirement}` : ""
  ].filter(Boolean).join("\n");
}

async function localOrRemoteImageToBlob(imageUrl) {
  const localPath = localMediaPathFromUrl(imageUrl);
  if (localPath && fs.existsSync(localPath)) {
    const contentType = mediaTypeFromFileName(localPath);
    return {
      blob: new Blob([fs.readFileSync(localPath)], { type: contentType }),
      fileName: `tryon-input.${extensionFromContentType(contentType)}`
    };
  }
  if (isRemoteUrl(imageUrl)) {
    const { contentType, buffer } = await fetchRawWithTimeout(imageUrl, { method: "GET" }, DEFAULT_TIMEOUT_MS);
    return {
      blob: new Blob([buffer], { type: contentType || "image/jpeg" }),
      fileName: `tryon-input.${extensionFromContentType(contentType)}`
    };
  }
  return null;
}

function extractOpenAIImage(payload) {
  const first = payload.data?.[0] || payload.output?.[0];
  return first?.b64_json || first?.image_base64 || first?.url || payload.b64_json || payload.image_url;
}

function shouldRetryImageOptimizer(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || "");
  return [408, 409, 429, 500, 502, 503, 504].includes(status) ||
    /timeout|timed out|gateway timeout|temporarily unavailable|rate limit/i.test(message);
}

function normalizeGarmentClass(value) {
  const raw = String(value || "").toLowerCase();
  if (/(skirt|半身裙|a字裙|百褶裙|包臀裙|伞裙|短裙|中长裙)/i.test(raw)) {
    return { key: "skirt", category: "pants", label: "半身裙", length: "lower", tryon_slot: "bottom", requires_full_body: true };
  }
  if (/(dress|gown|连衣|礼服|婚纱|旗袍|汉服|和服)/i.test(raw)) {
    return { key: "dress", category: "dress", label: "连衣裙", length: "full", tryon_slot: "top", requires_full_body: true };
  }
  if (/(pants|trouser|jeans|shorts|裤)/i.test(raw)) {
    return { key: "pants", category: "pants", label: "裤装", length: "long", tryon_slot: "bottom", requires_full_body: true };
  }
  if (/(shirt|top|coat|jacket|tee|blouse|sweater|hoodie|上衣|外套|衬衫|毛衣)/i.test(raw)) {
    return { key: "shirt", category: "shirt", label: "上衣", length: "upper", tryon_slot: "top", requires_full_body: false };
  }
  return null;
}

function parseJsonishContent(content) {
  const text = String(content || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(text);
  } catch {
    const category = text.match(/category["'\s:：]+([a-zA-Z_-]+)/i)?.[1] || text;
    return { category };
  }
}

async function classifyGarmentImage({ imageUrl, fileName = "", description = "" }) {
  if (process.env.GARMENT_CLASSIFIER_ENABLED === "false") return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !isRemoteUrl(imageUrl)) return null;

  const model = process.env.GARMENT_CLASSIFIER_MODEL || "gpt-4o-mini";
  const payload = await fetchWithTimeout(process.env.OPENAI_CHAT_URL || "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 180,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你是服装图片品类与试衣输入兼容性识别模型。你只做商品图可用性判断，不做绕过平台安全规则的建议。"
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "请识别图片中的服装主品类，只能在以下三类中选择：",
                "shirt=上衣/外套/衬衫/T恤/毛衣；dress=连衣裙/连体裤/礼服/旗袍等连身一体式；pants=下半身服装，包括裤子、短裤、半身裙。",
                `文件名：${fileName || "无"}；业务描述：${description || "无"}`,
                "同时判断这张图是否适合直接作为 FASHN/IDM-VTON 的 garment_image：优先平铺、假人或干净商品图；如果包含真人身体、大面积裸露皮肤、内衣/泳装、敏感文字、水印，风险较高。",
                "请只返回 JSON：{\"category\":\"shirt|dress|pants\",\"label\":\"上衣|连衣裙|裤装\",\"confidence\":0-1,\"reason\":\"一句话原因\",\"contains_person\":true|false,\"visible_skin_or_body\":true|false,\"intimate_or_swimwear\":true|false,\"watermark_or_sensitive_text\":true|false,\"fashn_input_risk\":\"low|medium|high\",\"fashn_risk_reason\":\"一句话说明\"}"
              ].join("\n")
            },
            { type: "image_url", image_url: { url: imageUrl } }
          ]
        }
      ]
    })
  }, Number(process.env.GARMENT_CLASSIFIER_TIMEOUT_MS || 90000));

  const content = payload.choices?.[0]?.message?.content || payload.output_text || payload.content;
  const parsed = parseJsonishContent(content);
  const normalized = normalizeGarmentClass(parsed.category || parsed.label || parsed.reason);
  if (!normalized) return null;
  return {
    ...normalized,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence || 0.72))),
    reason: parsed.reason || "视觉模型根据服装外形识别。",
    contains_person: Boolean(parsed.contains_person),
    visible_skin_or_body: Boolean(parsed.visible_skin_or_body),
    intimate_or_swimwear: Boolean(parsed.intimate_or_swimwear),
    watermark_or_sensitive_text: Boolean(parsed.watermark_or_sensitive_text),
    fashn_input_risk: ["low", "medium", "high"].includes(String(parsed.fashn_input_risk || "").toLowerCase())
      ? String(parsed.fashn_input_risk).toLowerCase()
      : "low",
    fashn_risk_reason: parsed.fashn_risk_reason || "",
    source: "vision_model",
    model
  };
}

async function assessFashnInputCompatibility({ garment, model: modelAsset }) {
  if (process.env.FASHN_INPUT_PRECHECK_ENABLED === "false") return null;
  const apiKey = process.env.OPENAI_API_KEY;
  const garmentUrl = garment?.file_url || garment?.preview_url;
  const modelUrl = modelAsset?.file_url || modelAsset?.preview_url;
  if (!apiKey || !isRemoteUrl(garmentUrl) || !isRemoteUrl(modelUrl)) return null;

  const model = process.env.FASHN_INPUT_PRECHECK_MODEL || process.env.GARMENT_CLASSIFIER_MODEL || "gpt-4o-mini";
  const payload = await fetchWithTimeout(process.env.OPENAI_CHAT_URL || "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你是虚拟试衣输入素材兼容性预检模型。目标是减少 FASHN/IDM-VTON 供应商内容检查拦截和无效调用。只给合规替换建议，不提供绕过安全检查的方法。"
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "请检查两张输入图是否适合送入 FASHN Try-On：第一张是服装主图 garment_image，第二张是真人模特图 model_image。",
                "服装主图推荐：平铺、假人、衣架、干净商品图；不推荐：真人穿着图、大面积人体皮肤、内衣/泳装、敏感文字、水印。",
                "模特图推荐：正面全身站姿、普通衣着、非暴露、背景简单；不推荐：内衣/泳装、裸露皮肤面积过大、姿态敏感、画面裁切严重。",
                `服装品类：${garment?.category_label || garment?.category || "未知"}；模特姿态：${modelAsset?.pose_type || "未知"}`,
                "请只返回 JSON：{\"safe_to_send_to_fashn\":true|false,\"risk_level\":\"low|medium|high\",\"likely_content_checker_block\":true|false,\"blocking_reasons\":[\"原因\"],\"suggestions\":[\"建议\"],\"garment_issue\":true|false,\"model_issue\":true|false}"
              ].join("\n")
            },
            { type: "image_url", image_url: { url: garmentUrl } },
            { type: "image_url", image_url: { url: modelUrl } }
          ]
        }
      ]
    })
  }, Number(process.env.FASHN_INPUT_PRECHECK_TIMEOUT_MS || 90000));

  const content = payload.choices?.[0]?.message?.content || payload.output_text || payload.content;
  const parsed = parseJsonishContent(content);
  const riskLevel = ["low", "medium", "high"].includes(String(parsed.risk_level || "").toLowerCase())
    ? String(parsed.risk_level).toLowerCase()
    : "medium";
  return {
    safe_to_send_to_fashn: Boolean(parsed.safe_to_send_to_fashn) && riskLevel !== "high",
    risk_level: riskLevel,
    likely_content_checker_block: Boolean(parsed.likely_content_checker_block),
    blocking_reasons: Array.isArray(parsed.blocking_reasons) ? parsed.blocking_reasons.slice(0, 5).map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 5).map(String) : [],
    garment_issue: Boolean(parsed.garment_issue),
    model_issue: Boolean(parsed.model_issue),
    model
  };
}

function resolveVisionImageInput(value) {
  const localPath = localMediaPathFromUrl(value);
  if (localPath && fs.existsSync(localPath)) return fileToDataUrl(localPath);
  return value;
}

function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  return /true|yes|pass|passed|生效|成功/i.test(String(value || ""));
}

function normalizeScore(value, fallback = 0.6) {
  return Math.max(0, Math.min(1, Number(value ?? fallback)));
}

async function validateTryOnEffectWithVision({ task, context, aiResult }) {
  if (process.env.TRYON_EFFECT_VALIDATOR_ENABLED === "false") return null;
  const apiKey = process.env.OPENAI_API_KEY;
  const personImage = resolveVisionImageInput(context.model?.file_url || context.model?.preview_url);
  const garmentImage = resolveVisionImageInput(context.garment?.file_url || context.garment?.preview_url);
  const resultImage = resolveVisionImageInput(aiResult.image_url || aiResult.cover_url);
  if (!apiKey || !personImage || !garmentImage || !resultImage) return null;

  const model = process.env.TRYON_EFFECT_VALIDATOR_MODEL || "gpt-4o";
  const payload = await fetchWithTimeout(process.env.OPENAI_CHAT_URL || "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 220,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "你是服装电商商品验货质检员，不是审美评分员。你的任务是判断试衣结果是否保留了同一件服装商品。相似款、同风格、同颜色、同品类都不能算通过。"
        },
        {
          role: "user",
          content: [
            { type: "text", text: [
              "下面依次是：1 原模特图，2 目标服装图，3 试衣结果图。",
              "请把目标服装图当作唯一商品验货标准。结果图必须是同一件商品被穿到模特身上，不是相似金色连衣裙、相似刺绣裙、相似礼服。",
              productFidelityRulesText(),
              `目标服装品类：${context.garment?.category_label || context.garment?.category || "未知"}。`,
              "严格判断三项：",
              "1. color_match：颜色是否与原图一致。只要明显偏浅、偏深、偏金属感变化或局部色泽变化，就 false。",
              "2. shape_length_match：三围比例、腰线、衣长/裙长/裤长、裙摆体量和廓形是否一比一还原。只要衣长、腰线、裙摆量感、廓形被改，就 false。",
              "3. detail_texture_match：装饰细节和纹理是否与原图一致。只要刺绣、蕾丝、花纹密度、边缘装饰、纹理走向被重构或简化，就 false。",
              "只有三项都明确一致，passed 才能 true。只要你不确定，或只能判断为相似款，必须返回 false。",
              "只返回 JSON：{\"passed\":true|false,\"confidence\":0-1,\"color_match\":true|false,\"color_score\":0-1,\"shape_length_match\":true|false,\"shape_length_score\":0-1,\"detail_texture_match\":true|false,\"detail_texture_score\":0-1,\"reason\":\"一句话说明通过或失败原因\",\"issue_tags\":[\"颜色不一致\",\"衣长比例不一致\",\"纹理细节不一致\"]}"
            ].join("\n") },
            { type: "image_url", image_url: { url: personImage } },
            { type: "image_url", image_url: { url: garmentImage } },
            { type: "image_url", image_url: { url: resultImage } }
          ]
        }
      ]
    })
  }, Number(process.env.TRYON_EFFECT_VALIDATOR_TIMEOUT_MS || 90000));
  const content = payload.choices?.[0]?.message?.content || payload.output_text || payload.content;
  const parsed = parseJsonishContent(content);
  const colorMatch = normalizeBoolean(parsed.color_match ?? parsed.colorMatch ?? false);
  const shapeLengthMatch = normalizeBoolean(parsed.shape_length_match ?? parsed.shapeLengthMatch ?? false);
  const detailTextureMatch = normalizeBoolean(parsed.detail_texture_match ?? parsed.detailTextureMatch ?? false);
  const colorScore = normalizeScore(parsed.color_score ?? parsed.colorScore, colorMatch ? 0.82 : 0.35);
  const shapeLengthScore = normalizeScore(parsed.shape_length_score ?? parsed.shapeLengthScore, shapeLengthMatch ? 0.82 : 0.35);
  const detailTextureScore = normalizeScore(parsed.detail_texture_score ?? parsed.detailTextureScore, detailTextureMatch ? 0.82 : 0.35);
  const fidelityPassed = colorMatch && shapeLengthMatch && detailTextureMatch && colorScore >= 0.82 && shapeLengthScore >= 0.82 && detailTextureScore >= 0.82;
  const passed = normalizeBoolean(parsed.passed) && fidelityPassed;
  const issueTags = Array.isArray(parsed.issue_tags) ? parsed.issue_tags.map(String).slice(0, 4) : [];
  if (!colorMatch || colorScore < 0.72) issueTags.push("颜色不一致");
  if (!shapeLengthMatch || shapeLengthScore < 0.72) issueTags.push("衣长比例不一致");
  if (!detailTextureMatch || detailTextureScore < 0.72) issueTags.push("纹理细节不一致");
  return {
    passed,
    confidence: normalizeScore(parsed.confidence, 0.6),
    color_match: colorMatch,
    color_score: colorScore,
    shape_length_match: shapeLengthMatch,
    shape_length_score: shapeLengthScore,
    detail_texture_match: detailTextureMatch,
    detail_texture_score: detailTextureScore,
    product_fidelity_passed: fidelityPassed,
    reason: parsed.reason || "视觉质检模型完成试衣生效判断。",
    issue_tags: Array.from(new Set(issueTags)).slice(0, 6),
    model
  };
}

async function optimizeImageWithOpenAI(task, context, aiResult, index) {
  if (!shouldOptimizeWithOpenAI(task) || aiResult.media_type !== "image") return aiResult;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return aiResult;
  const imageSource = await localOrRemoteImageToBlob(aiResult.image_url || aiResult.cover_url);
  if (!imageSource) return aiResult;
  const garmentReferences = [];
  for (const source of garmentReferenceInputs(context)) {
    const image = await localOrRemoteImageToBlob(source.url);
    if (image) garmentReferences.push({ ...source, ...image });
  }

  const model = task.params?.post_optimize?.model || process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5";
  const size = task.params?.post_optimize?.size || process.env.OPENAI_IMAGE_OPTIMIZER_SIZE || "1024x1536";
  const quality = task.params?.post_optimize?.quality || process.env.OPENAI_IMAGE_OPTIMIZER_QUALITY || "high";
  const outputFormat = process.env.OPENAI_IMAGE_OPTIMIZER_OUTPUT_FORMAT || "png";
  reportTaskStage(task, "gpt_image_optimizing", task.active_progress?.gpt || 88, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在进行最终商用出图`);
  const maxAttempts = Math.max(1, Number(process.env.OPENAI_IMAGE_OPTIMIZER_MAX_ATTEMPTS || 3));
  let payload = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", buildOpenAIOptimizationPrompt(task, context));
    form.append("image", imageSource.blob, imageSource.fileName);
    garmentReferences.forEach((reference, referenceIndex) => {
      const fileBase = referenceIndex === 0 ? "garment-front-reference" : `garment-detail-reference-${referenceIndex}`;
      form.append("image", reference.blob, `${fileBase}.${extensionFromContentType(reference.blob.type)}`);
    });
    form.append("size", size);
    form.append("quality", quality);
    form.append("n", "1");
    form.append("output_format", outputFormat);
    form.append("background", "opaque");
    form.append("input_fidelity", process.env.OPENAI_IMAGE_OPTIMIZER_INPUT_FIDELITY || "high");
    try {
      payload = await fetchWithTimeout(process.env.OPENAI_IMAGE_EDIT_URL || "https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: form
      }, Number(process.env.OPENAI_IMAGE_OPTIMIZER_TIMEOUT_MS || 360000));
      task.stage_timings[`openai_image_optimize_${index}_attempts`] = attempt;
      break;
    } catch (error) {
      lastError = error;
      task.stage_timings[`openai_image_optimize_${index}_attempt_${attempt}_error`] = {
        error: error?.message || String(error),
        status: error?.status || null,
        at: new Date().toISOString()
      };
      if (attempt >= maxAttempts || !shouldRetryImageOptimizer(error)) throw error;
      await sleep(Number(process.env.OPENAI_IMAGE_OPTIMIZER_RETRY_INTERVAL_MS || 3000) * attempt);
    }
  }
  if (!payload && lastError) throw lastError;

  const image = extractOpenAIImage(payload);
  if (!image) return aiResult;
  let optimizedUrl = aiResult.image_url;
  if (isRemoteUrl(image)) {
    optimizedUrl = await downloadRemoteMediaToLocal(task, `openai-${index}`, image, "image");
  } else {
    optimizedUrl = saveProviderImage(task, `openai-${index}`, Buffer.from(image, "base64"), `image/${outputFormat}`);
  }
  task.stage_timings[`openai_image_optimize_${index}`] = {
    model,
    source_url: aiResult.image_url,
    garment_reference_urls: garmentReferences.map(item => item.url),
    garment_reference_count: garmentReferences.length,
    garment_detail_reference_count: Math.max(0, garmentReferences.length - 1),
    optimized_url: optimizedUrl,
    size,
    quality
  };
  return {
    ...aiResult,
    image_url: optimizedUrl,
    cover_url: optimizedUrl,
    model_meta: {
      ...(aiResult.model_meta || {}),
      openai_image_optimizer: model,
      openai_image_optimizer_size: size,
      openai_image_optimizer_quality: quality,
      openai_image_optimizer_reference_count: garmentReferences.length,
      openai_image_optimizer_detail_reference_count: Math.max(0, garmentReferences.length - 1)
    }
  };
}

function isRemoteUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isDataUrl(value) {
  return typeof value === "string" && /^data:/i.test(value);
}

async function uploadSegmindAsset(dataUrl, apiKey) {
  const payload = await fetchWithTimeout("https://workflows-api.segmind.com/upload-asset", {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({ data_urls: [dataUrl] })
  });
  const uploadedUrl = payload.urls?.[0] || payload.data?.urls?.[0];
  if (!uploadedUrl) throw new Error("Segmind asset upload did not return a URL");
  return uploadedUrl;
}

async function resolveSegmindInputUrl(value, apiKey, fallbackUrl) {
  if (isRemoteUrl(value)) return value;
  if (isDataUrl(value)) return uploadSegmindAsset(value, apiKey);
  return fallbackUrl;
}

function mapTryOnCategory(category) {
  if (category === "pants") return "Lower body";
  if (category === "dress") return "Dress";
  return "Upper body";
}

function mapIdmVtonCategory(garment) {
  const category = garment?.category;
  const key = garment?.category_key;
  if (category === "dress" || key === "dress" || key === "formal_dress" || key === "traditional") return "dresses";
  if (category === "pants" || key === "pants" || key === "skirt" || key === "shorts") return "lower_body";
  return "upper_body";
}

function mapPixazoIdmVtonCategory(garment) {
  const category = garment?.category;
  const key = garment?.category_key;
  if (category === "dress" || key === "dress" || key === "formal_dress" || key === "traditional") return "dresses";
  if (category === "pants" || key === "pants" || key === "skirt" || key === "shorts") return "lower_body";
  return "upper_body";
}

function mapPixazoFashnCategory(garment) {
  const category = garment?.category;
  const key = garment?.category_key;
  if (category === "dress" || key === "dress" || key === "formal_dress" || key === "traditional") return "one-pieces";
  if (category === "pants" || key === "pants" || key === "skirt" || key === "shorts") return "bottoms";
  return "tops";
}

function map302FashnCategory(garment) {
  const category = garment?.category;
  const key = garment?.category_key;
  if (category === "dress" || key === "dress" || key === "formal_dress" || key === "traditional") return "dresses";
  if (category === "pants" || key === "pants" || key === "skirt" || key === "shorts") return "lower_body";
  return "upper_body";
}

function coerce302FashnCategory(value, fallback) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "upper_body" || raw === "lower_body" || raw === "dresses") return raw;
  if (raw === "tops" || raw === "top" || raw === "shirt" || raw === "upper") return "upper_body";
  if (raw === "bottoms" || raw === "bottom" || raw === "pants" || raw === "skirt" || raw === "lower") return "lower_body";
  if (raw === "one-pieces" || raw === "one_piece" || raw === "dress" || raw === "dresses") return "dresses";
  return fallback;
}

function buildGarmentFidelityDescription(garment, fallback = "garment") {
  return [
    garment?.category_label || garment?.category || fallback,
    "Hard rule: keep garment color identical to the original image.",
    "Hard rule: keep garment body proportions, width, silhouette and length exactly one-to-one.",
    "Hard rule: keep decorative details, embroidery, buttons, logo, fabric texture and pattern identical to the original image.",
    "Do not redesign the garment. Do not change it into another fashion item."
  ].filter(Boolean).join(". ");
}

function parseSegmindJsonResult(payload) {
  return (
    payload.image_url ||
    payload.output_url ||
    payload.url ||
    payload.data?.image_url ||
    payload.data?.output_url ||
    payload.data?.url ||
    payload.output?.[0] ||
    payload.images?.[0]
  );
}

async function callSegmindImageTryOn(task, context, index) {
  const apiKey = process.env.SEGMIND_API_KEY;
  if (!apiKey) return mockImageResult(task, index);

  const modelName = process.env.SEGMIND_TRYON_MODEL || "segfit-v1.3";
  const baseUrl = process.env.SEGMIND_API_BASE_URL || "https://api.segmind.com/v1";
  const defaultModelUrl = process.env.SEGMIND_DEFAULT_MODEL_IMAGE_URL ||
    "https://segmind-resources.s3.amazonaws.com/output/d3539958-a892-455e-b00f-aa46e7cfa70b-segfit-v1.3-ip.png";
  const defaultOutfitUrl = process.env.SEGMIND_DEFAULT_OUTFIT_IMAGE_URL ||
    "https://segmind-resources.s3.amazonaws.com/output/217c8192-d055-4fec-b1cf-82325c9cb0b2-segfit-v1.3-outfit.JPG";

  const garmentInput = context.garment?.file_url || context.garment?.preview_url;
  const modelInput = context.model?.file_url || context.model?.preview_url;
  const outfitUrl = await resolveSegmindInputUrl(garmentInput, apiKey, defaultOutfitUrl);
  const modelUrl = await resolveSegmindInputUrl(modelInput, apiKey, defaultModelUrl);

  const endpoint = modelName === "try-on-diffusion" ? "try-on-diffusion" : "segfit-v1.3";
  const body = endpoint === "try-on-diffusion"
    ? {
        model_image: modelUrl,
        cloth_image: outfitUrl,
        category: mapTryOnCategory(context.garment?.category),
        num_inference_steps: Number(process.env.SEGMIND_NUM_INFERENCE_STEPS || 35),
        guidance_scale: Number(process.env.SEGMIND_GUIDANCE_SCALE || 2),
        seed: Number(process.env.SEGMIND_SEED || -1),
        base64: false
      }
    : {
        outfit_image: outfitUrl,
        model_image: modelUrl,
        model_type: process.env.SEGMIND_MODEL_TYPE || "Quality",
        cn_strength: Number(process.env.SEGMIND_CN_STRENGTH || 0.8),
        cn_end: Number(process.env.SEGMIND_CN_END || 0.5),
        image_format: process.env.SEGMIND_IMAGE_FORMAT || "jpeg",
        image_quality: Number(process.env.SEGMIND_IMAGE_QUALITY || 90),
        seed: Number(process.env.SEGMIND_SEED || -1),
        base64: false
      };

  const { contentType, buffer } = await fetchRawWithTimeout(`${baseUrl.replace(/\/$/, "")}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify(body)
  });

  let imageUrl = null;
  if (contentType.includes("application/json")) {
    const payload = JSON.parse(buffer.toString("utf8"));
    imageUrl = parseSegmindJsonResult(payload);
    if (!imageUrl && payload.image) {
      imageUrl = saveProviderImage(task, index, Buffer.from(payload.image, "base64"), `image/${process.env.SEGMIND_IMAGE_FORMAT || "jpeg"}`);
    }
  } else {
    imageUrl = saveProviderImage(task, index, buffer, contentType);
  }

  if (!imageUrl) throw new Error("Segmind did not return an image");

  return {
    provider: "segmind",
    media_type: "image",
    image_url: imageUrl,
    cover_url: imageUrl,
    model_meta: {
      image_model: `segmind/${endpoint}`,
      provider_task_id: null
    }
  };
}

async function callReplicateIdmVton(task, context, index) {
  const apiKey = process.env.REPLICATE_API_TOKEN;
  if (!apiKey) {
    throw new Error("REPLICATE_API_TOKEN is required when selecting Replicate IDM-VTON.");
  }
  const personUrl = context.model?.file_url || context.model?.preview_url;
  const garmentUrl = context.garment?.file_url || context.garment?.preview_url;
  if (!isRemoteUrl(personUrl) || !isRemoteUrl(garmentUrl)) {
    throw new Error("Replicate IDM-VTON requires public HTTP/HTTPS person and garment image URLs.");
  }

  const modelPath = process.env.REPLICATE_IDM_VTON_MODEL || "cuuupid/idm-vton";
  const modelVersion = process.env.REPLICATE_IDM_VTON_VERSION || "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985";
  const baseUrl = (process.env.REPLICATE_API_BASE_URL || "https://api.replicate.com/v1").replace(/\/$/, "");
  const category = mapIdmVtonCategory(context.garment);
  const garmentDescription = buildGarmentFidelityDescription(context.garment);

  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在使用 IDM-VTON 虚拟试衣中`);
  const payload = await fetchWithTimeout(`${baseUrl}/predictions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Prefer: "wait"
    },
    body: JSON.stringify({
      version: modelVersion,
      input: {
        human_img: personUrl,
        garm_img: garmentUrl,
        garment_des: task.params?.image?.garment_description || garmentDescription,
        category,
        crop: task.params?.image?.idm_crop ?? false,
        force_dc: category === "dresses",
        seed: Number(task.params?.image?.seed || process.env.REPLICATE_IDM_VTON_SEED || 42),
        steps: Number(process.env.REPLICATE_IDM_VTON_STEPS || 30)
      }
    })
  }, Number(process.env.REPLICATE_TIMEOUT_MS || 300000));

  let finalPayload = payload;
  let output = Array.isArray(payload.output) ? payload.output[0] : payload.output;
  const predictionId = payload.id;
  if (!output && predictionId && payload.status !== "succeeded") {
    const maxPolls = Number(process.env.REPLICATE_MAX_POLLS || 120);
    const intervalMs = Number(process.env.REPLICATE_POLL_INTERVAL_MS || 3000);
    const statusUrl = payload.urls?.get || `${baseUrl}/predictions/${encodeURIComponent(predictionId)}`;
    for (let i = 0; i < maxPolls; i += 1) {
      finalPayload = await fetchWithTimeout(statusUrl, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (finalPayload.status === "succeeded") {
        output = Array.isArray(finalPayload.output) ? finalPayload.output[0] : finalPayload.output;
        break;
      }
      if (["failed", "canceled"].includes(finalPayload.status)) {
        throw new Error(finalPayload.error || "Replicate IDM-VTON task failed");
      }
      await sleep(intervalMs);
    }
  }

  if (!output) throw new Error("Replicate IDM-VTON did not return an output image");
  const localUrl = await downloadRemoteMediaToLocal(task, `idm-vton-${index}`, output, "image");
  return {
    provider: "replicate",
    media_type: "image",
    image_url: localUrl,
    cover_url: localUrl,
    model_meta: {
      image_model: `replicate/${modelPath}`,
      image_model_version: modelVersion,
      provider_task_id: predictionId || null,
      idm_vton_category: category,
      idm_vton_non_commercial_notice: "Replicate model page marks this model as Non-Commercial use only."
    }
  };
}

function parsePixazoImageResult(payload) {
  return (
    payload.result_url ||
    payload.image_url ||
    payload.output_url ||
    payload.url ||
    payload.data?.result_url ||
    payload.data?.image_url ||
    payload.data?.output_url ||
    payload.data?.url ||
    payload.output?.media_url?.[0] ||
    payload.output?.media_urls?.[0] ||
    payload.output?.url ||
    payload.output?.result_url ||
    payload.output?.result_url ||
    payload.output?.image_url ||
    payload.output?.[0] ||
    (Array.isArray(payload.output) ? payload.output[0] : null)
  );
}

function parse302FashnImageResult(payload) {
  const images = payload.images || payload.data?.images || payload.output?.images;
  if (Array.isArray(images) && images.length) {
    const first = images[0];
    if (typeof first === "string") return first;
    return first.url || first.image_url || first.output_url || first.uri;
  }
  const output = payload.output || payload.data?.output || payload.result;
  if (Array.isArray(output) && output.length) {
    const first = output[0];
    if (typeof first === "string") return first;
    return first.url || first.image_url || first.output_url || first.uri;
  }
  return (
    payload.image_url ||
    payload.output_url ||
    payload.result_url ||
    payload.url ||
    payload.data?.image_url ||
    payload.data?.output_url ||
    payload.data?.result_url ||
    payload.data?.url ||
    payload.output?.image_url ||
    payload.output?.url
  );
}

function parsePixelcutTryOnImageResult(payload) {
  const candidates = [
    payload.result_url,
    payload.image_url,
    payload.output_url,
    payload.url,
    payload.data?.result_url,
    payload.data?.image_url,
    payload.data?.output_url,
    payload.data?.url,
    payload.result?.url,
    payload.output?.url,
    payload.output?.image_url,
    payload.output?.[0],
    Array.isArray(payload.images) ? payload.images[0] : null,
    Array.isArray(payload.data?.images) ? payload.data.images[0] : null
  ].filter(Boolean);
  const first = candidates[0];
  if (!first) return null;
  if (typeof first === "string") return first;
  return first.url || first.image_url || first.output_url || first.result_url || null;
}

function pixelcutTryOnJobId(payload) {
  return payload.job_id || payload.id || payload.task_id || payload.data?.job_id || payload.data?.id || payload.result?.job_id;
}

function pixelcutTryOnStatus(payload) {
  return String(payload.status || payload.data?.status || payload.result?.status || "").toLowerCase();
}

function mapPixelcutGarmentMode(garment) {
  const category = garment?.category;
  const key = garment?.category_key;
  if (category === "dress" || key === "dress" || key === "formal_dress" || key === "traditional" || key === "jumpsuit") return "full";
  if (category === "pants" || key === "pants" || key === "skirt" || key === "shorts") return "lower";
  return "upper";
}

async function pollPixelcutTryOn({ task, statusUrl, apiKey, index }) {
  const maxPolls = Number(process.env.PIXELCUT_TRYON_MAX_POLLS || 120);
  const intervalMs = Number(process.env.PIXELCUT_TRYON_POLL_INTERVAL_MS || 3000);
  let payload = null;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(intervalMs);
    reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在虚拟试衣中`);
    payload = await fetchWithTimeout(statusUrl, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey
      }
    }, Number(process.env.PIXELCUT_TRYON_TIMEOUT_MS || 300000));
    const output = parsePixelcutTryOnImageResult(payload);
    if (output) return payload;
    const status = pixelcutTryOnStatus(payload);
    if (["succeeded", "success", "completed", "complete"].includes(status)) return payload;
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(payload.error || payload.message || payload.detail || `Pixelcut Try-On task ${status}`);
    }
  }
  throw new Error(`Pixelcut Try-On timed out waiting for result${payload ? `: ${JSON.stringify(payload).slice(0, 500)}` : ""}`);
}

async function callPixelcutTryOn(task, context, index) {
  const apiKey = process.env.PIXELCUT_API_KEY;
  if (!apiKey) {
    throw new Error("PIXELCUT_API_KEY is required when selecting Pixelcut Try-On.");
  }
  const personUrl = context.model?.file_url || context.model?.preview_url;
  const garmentUrl = context.garment?.file_url || context.garment?.preview_url;
  if (!isRemoteUrl(personUrl) || !isRemoteUrl(garmentUrl)) {
    throw new Error("Pixelcut Try-On requires public HTTP/HTTPS person and garment image URLs.");
  }

  const endpoint = process.env.PIXELCUT_TRYON_URL || "https://api.developer.pixelcut.ai/v1/try-on";
  const garmentMode = process.env.PIXELCUT_TRYON_GARMENT_MODE || mapPixelcutGarmentMode(context.garment);
  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在虚拟试衣中`);

  let createPayload;
  try {
    createPayload = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey
      },
      body: JSON.stringify({
        person_image_url: personUrl,
        garment_image_url: garmentUrl,
        garment_mode: garmentMode,
        preprocess_garment: process.env.PIXELCUT_TRYON_PREPROCESS_GARMENT || "true",
        remove_background: process.env.PIXELCUT_TRYON_REMOVE_BACKGROUND || "false",
        wait_for_result: process.env.PIXELCUT_TRYON_WAIT_FOR_RESULT || "true"
      })
    }, Number(process.env.PIXELCUT_TRYON_TIMEOUT_MS || 300000));
  } catch (error) {
    const providerMessage = error?.message && error.message !== "[object Object]"
      ? error.message
      : stringifyProviderError(error?.provider_payload || error);
    const wrapped = new Error(`Pixelcut Try-On request failed: ${providerMessage}`);
    wrapped.status = error?.status;
    wrapped.provider_payload = error?.provider_payload;
    throw wrapped;
  }

  let finalPayload = createPayload;
  let output = parsePixelcutTryOnImageResult(finalPayload);
  const jobId = pixelcutTryOnJobId(createPayload);
  if (!output && jobId) {
    const statusUrl = (process.env.PIXELCUT_TRYON_STATUS_URL || "https://api.developer.pixelcut.ai/v1/try-on/job/{job_id}")
      .replace("{job_id}", encodeURIComponent(jobId));
    finalPayload = await pollPixelcutTryOn({ task, statusUrl, apiKey, index });
    output = parsePixelcutTryOnImageResult(finalPayload);
  }
  if (!output) {
    throw new Error(`Pixelcut Try-On did not return an output image: ${JSON.stringify(finalPayload).slice(0, 500)}`);
  }

  const localUrl = await downloadRemoteMediaToLocal(task, `pixelcut-tryon-${index}`, output, "image");
  return {
    provider: "pixelcut",
    media_type: "image",
    image_url: localUrl,
    cover_url: localUrl,
    model_meta: {
      image_model: "pixelcut/try-on",
      provider_task_id: jobId || finalPayload.id || finalPayload.task_id || null,
      pixelcut_endpoint: endpoint,
      pixelcut_garment_mode: garmentMode,
      pixelcut_status: pixelcutTryOnStatus(finalPayload) || null
    }
  };
}

async function call302FashnTryOn(task, context, index) {
  const apiKey = process.env.THREE_O_TWO_API_KEY || process.env.API_302_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("THREE_O_TWO_API_KEY is required when selecting 302.AI FASHN Try-On.");
  }
  const personUrl = context.model?.file_url || context.model?.preview_url;
  const garmentUrl = context.garment?.file_url || context.garment?.preview_url;
  if (!isRemoteUrl(personUrl) || !isRemoteUrl(garmentUrl)) {
    throw new Error("302.AI FASHN Try-On requires public HTTP/HTTPS person and garment image URLs.");
  }

  const endpoint = process.env.THREE_O_TWO_FASHN_TRYON_URL || "https://api.302.ai/302/submit/fashn-tryon-v1.5";
  const fallbackCategory = map302FashnCategory(context.garment);
  const category = coerce302FashnCategory(task.params?.image?.fashn_category || process.env.THREE_O_TWO_FASHN_CATEGORY, fallbackCategory);
  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在虚拟试衣中`);

  let payload;
  try {
    payload = await fetchWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model_image: personUrl,
        garment_image: garmentUrl,
        category,
        mode: process.env.THREE_O_TWO_FASHN_MODE || "quality",
        garment_photo_type: process.env.THREE_O_TWO_FASHN_GARMENT_PHOTO_TYPE || "auto",
        moderation_level: process.env.THREE_O_TWO_FASHN_MODERATION_LEVEL || "none",
        restore_background: process.env.THREE_O_TWO_FASHN_RESTORE_BACKGROUND !== "false",
        restore_clothes: process.env.THREE_O_TWO_FASHN_RESTORE_CLOTHES !== "false",
        long_top: category === "upper_body" && (context.garment?.requires_full_body || context.garment?.length === "long"),
        num_samples: 1,
        seed: Number(task.params?.image?.seed || process.env.THREE_O_TWO_FASHN_SEED || -1)
      })
    }, Number(process.env.THREE_O_TWO_FASHN_TIMEOUT_MS || 360000));
  } catch (error) {
    const providerMessage = error?.message && error.message !== "[object Object]"
      ? error.message
      : stringifyProviderError(error?.provider_payload || error);
    const wrapped = new Error(`302.AI FASHN Try-On request failed: ${providerMessage}`);
    wrapped.status = error?.status;
    wrapped.provider_payload = error?.provider_payload;
    throw wrapped;
  }

  const output = parse302FashnImageResult(payload);
  if (!output) {
    throw new Error(`302.AI FASHN Try-On did not return an output image: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  const localUrl = await downloadRemoteMediaToLocal(task, `302-fashn-tryon-${index}`, output, "image");
  return {
    provider: "302-ai-fashn",
    media_type: "image",
    image_url: localUrl,
    cover_url: localUrl,
    model_meta: {
      image_model: "302.ai/fashn-tryon-v1.5",
      provider_task_id: payload.id || payload.task_id || payload.request_id || null,
      fashn_endpoint: endpoint,
      fashn_category: category,
      fashn_fallback_category: fallbackCategory,
      fashn_mode: process.env.THREE_O_TWO_FASHN_MODE || "quality"
    }
  };
}

function pixazoStatusValue(payload) {
  return String(payload?.status || payload?.data?.status || "").toLowerCase();
}

function pixazoRequestId(payload) {
  return payload?.request_id || payload?.id || payload?.job_set_id || payload?.task_id || payload?.data?.request_id || payload?.data?.id;
}

function pixazoPollingUrls(endpoint, payload) {
  const urls = [];
  if (payload?.polling_url) urls.push(payload.polling_url);
  if (payload?.data?.polling_url) urls.push(payload.data.polling_url);
  const requestId = pixazoRequestId(payload);
  if (requestId) {
    try {
      const origin = new URL(endpoint).origin;
      urls.push(`${origin}/v2/requests/status/${encodeURIComponent(requestId)}`);
    } catch {
      // Keep explicit polling URLs only if endpoint parsing fails.
    }
  }
  return Array.from(new Set(urls.filter(Boolean)));
}

async function pollPixazoIdmVton({ task, endpoint, initialPayload, apiKey, index }) {
  let payload = initialPayload;
  let output = parsePixazoImageResult(payload);
  if (output) return payload;

  const status = pixazoStatusValue(payload);
  const requestId = pixazoRequestId(payload);
  const isPending = ["starting", "queued", "processing", "pending", "running", "in_progress"].includes(status);
  if (!isPending && !requestId) return payload;

  const pollingUrls = pixazoPollingUrls(endpoint, payload);
  if (!pollingUrls.length) {
    throw new Error(`Pixazo IDM-VTON returned async status "${status || "unknown"}" but no polling URL or request id: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const maxPolls = Number(process.env.PIXAZO_MAX_POLLS || 120);
  const intervalMs = Number(process.env.PIXAZO_POLL_INTERVAL_MS || 5000);
  let lastError = null;
  for (let i = 0; i < maxPolls; i += 1) {
    await sleep(intervalMs);
    reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：Pixazo 试衣生成中，等待出图`);
    for (const statusUrl of pollingUrls) {
      try {
        payload = await fetchWithTimeout(statusUrl, {
          method: "GET",
          headers: {
            "Cache-Control": "no-cache",
            "Ocp-Apim-Subscription-Key": apiKey
          }
        }, Number(process.env.PIXAZO_TIMEOUT_MS || 300000));
        payload.__status_endpoint = statusUrl;
        output = parsePixazoImageResult(payload);
        const currentStatus = pixazoStatusValue(payload);
        if (output || ["completed", "complete", "succeeded", "success"].includes(currentStatus)) return payload;
        if (["failed", "error", "canceled", "cancelled"].includes(currentStatus)) {
          throw new Error(payload.error || payload.message || payload.detail || `Pixazo IDM-VTON task ${currentStatus}`);
        }
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error(`Pixazo IDM-VTON timed out waiting for result${lastError ? `: ${lastError.message || lastError}` : ""}`);
}

async function callPixazoIdmVton(task, context, index) {
  const apiKey = process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY;
  if (!apiKey) {
    throw new Error("PIXAZO_API_KEY is required when selecting Pixazo IDM-VTON.");
  }
  const personUrl = context.model?.file_url || context.model?.preview_url;
  const garmentUrl = context.garment?.file_url || context.garment?.preview_url;
  if (!isRemoteUrl(personUrl) || !isRemoteUrl(garmentUrl)) {
    throw new Error("Pixazo IDM-VTON requires public HTTP/HTTPS person and garment image URLs.");
  }

  const endpoint = process.env.PIXAZO_IDM_VTON_URL || "https://gateway.pixazo.ai/idm-vton-api/v1/r-idm-vton";
  const fallbackEndpoint = process.env.PIXAZO_IDM_VTON_FALLBACK_URL || "https://gateway.appypie.com/idm-vton-api/v1/r-idm-vton";
  const endpoints = Array.from(new Set([endpoint, fallbackEndpoint].filter(Boolean)));
  const category = mapPixazoIdmVtonCategory(context.garment);
  const garmentDescription = task.params?.image?.garment_description || buildGarmentFidelityDescription(context.garment);
  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在使用 Pixazo IDM-VTON 虚拟试衣中`);

  let payload;
  const errors = [];
  for (const url of endpoints) {
    try {
      payload = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "Ocp-Apim-Subscription-Key": apiKey
        },
        body: JSON.stringify({
          garm_img: garmentUrl,
          human_img: personUrl,
          garment_des: garmentDescription,
          category
        })
      }, Number(process.env.PIXAZO_TIMEOUT_MS || 300000));
      if (payload) {
        payload.__endpoint = url;
        payload = await pollPixazoIdmVton({ task, endpoint: url, initialPayload: payload, apiKey, index });
        payload.__endpoint = payload.__endpoint || url;
        break;
      }
    } catch (error) {
      errors.push({
        endpoint: url,
        status: error.status || null,
        message: error.message || String(error),
        response: error.provider_payload || error.response_body || null
      });
      const canRetryEndpoint =
        !error.status ||
        [401, 403, 404, 429, 500, 502, 503, 504].includes(Number(error.status)) ||
        /fetch failed|getaddrinfo|enotfound|eai_again|network/i.test(error.message || "");
      if (!canRetryEndpoint || url === endpoints[endpoints.length - 1]) {
        const detail = errors.map(item => {
          const response = item.response ? ` ${JSON.stringify(item.response).slice(0, 240)}` : "";
          return `${item.endpoint}: ${item.status || "network"} ${item.message}${response}`;
        }).join(" | ");
        const wrapped = new Error(`Pixazo IDM-VTON failed after ${errors.length} endpoint(s). ${detail}`);
        wrapped.status = error.status;
        wrapped.provider_payload = { errors };
        throw wrapped;
      }
    }
  }
  if (!payload) {
    const detail = errors.map(item => `${item.endpoint}: ${item.status || "network"} ${item.message}`).join(" | ");
    throw new Error(`Pixazo IDM-VTON network failed. ${detail}`);
  }

  const output = parsePixazoImageResult(payload);
  if (!output) throw new Error(`Pixazo IDM-VTON did not return an output image: ${JSON.stringify(payload).slice(0, 500)}`);
  const localUrl = await downloadRemoteMediaToLocal(task, `pixazo-idm-vton-${index}`, output, "image");
  return {
    provider: "pixazo",
    media_type: "image",
    image_url: localUrl,
    cover_url: localUrl,
    model_meta: {
      image_model: "pixazo/idm-vton",
      provider_task_id: payload.job_set_id || payload.id || payload.task_id || null,
      pixazo_endpoint: payload.__endpoint || endpoint,
      pixazo_status_endpoint: payload.__status_endpoint || null,
      pixazo_status: payload.status || null,
      pixazo_processing_time: payload.processing_time || null,
      idm_vton_category: category
    }
  };
}

async function callPixazoFashnVton(task, context, index) {
  const apiKey = process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY;
  if (!apiKey) {
    throw new Error("PIXAZO_API_KEY is required when selecting Pixazo Fashn VTON.");
  }
  const personUrl = context.model?.file_url || context.model?.preview_url;
  const garmentUrl = context.garment?.file_url || context.garment?.preview_url;
  if (!isRemoteUrl(personUrl) || !isRemoteUrl(garmentUrl)) {
    throw new Error("Pixazo Fashn VTON requires public HTTP/HTTPS person and garment image URLs.");
  }

  const endpoint = process.env.PIXAZO_FASHN_VTON_URL || "https://gateway.pixazo.ai/fashn-virtual-try-on/v1/fashn-virtual-try-on-request";
  const category = task.params?.image?.pixazo_category || mapPixazoFashnCategory(context.garment);
  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：Pixazo 试衣生成中`);

  const payload = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "Ocp-Apim-Subscription-Key": apiKey
    },
    body: JSON.stringify({
      model_image: personUrl,
      garment_image: garmentUrl,
      category,
      mode: process.env.PIXAZO_FASHN_MODE || "balanced",
      garment_photo_type: process.env.PIXAZO_FASHN_GARMENT_PHOTO_TYPE || "auto",
      moderation_level: process.env.PIXAZO_FASHN_MODERATION_LEVEL || "permissive",
      num_samples: 1,
      segmentation_free: process.env.PIXAZO_FASHN_SEGMENTATION_FREE !== "false",
      output_format: process.env.PIXAZO_FASHN_OUTPUT_FORMAT || "png"
    })
  }, Number(process.env.PIXAZO_TIMEOUT_MS || 300000));
  payload.__endpoint = endpoint;

  const finalPayload = await pollPixazoIdmVton({ task, endpoint, initialPayload: payload, apiKey, index });
  finalPayload.__endpoint = finalPayload.__endpoint || endpoint;
  const output = parsePixazoImageResult(finalPayload);
  if (!output) throw new Error(`Pixazo Fashn VTON did not return an output image: ${JSON.stringify(finalPayload).slice(0, 500)}`);
  const localUrl = await downloadRemoteMediaToLocal(task, `pixazo-fashn-vton-${index}`, output, "image");
  return {
    provider: "pixazo",
    media_type: "image",
    image_url: localUrl,
    cover_url: localUrl,
    model_meta: {
      image_model: "pixazo/fashn-virtual-try-on",
      provider_task_id: finalPayload.request_id || finalPayload.id || payload.request_id || null,
      pixazo_endpoint: finalPayload.__endpoint || endpoint,
      pixazo_status_endpoint: finalPayload.__status_endpoint || payload.polling_url || null,
      pixazo_status: finalPayload.status || null,
      pixazo_category: category,
      pixazo_backend_note: "Pixazo IDM endpoint returns async starting without a usable polling URL; Fashn VTON is used for reliable polling."
    }
  };
}

function extractAliyunTaskId(payload) {
  return payload.output?.task_id || payload.task_id || payload.data?.task_id;
}

function extractAliyunStatus(payload) {
  return payload.output?.task_status || payload.task_status || payload.status || payload.data?.task_status;
}

function extractAliyunImageUrl(payload) {
  return payload.output?.image_url || payload.image_url || payload.data?.image_url || payload.output_url;
}

function extractQwenEditImageUrl(payload) {
  const content = payload.output?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    const imageItem = content.find(item => item.image);
    if (imageItem?.image) return imageItem.image;
  }
  return payload.output?.image_url || payload.image_url || payload.data?.image_url;
}

function shouldPreEdit(task) {
  if (task.params?.pre_edit?.enabled === false) return false;
  const taskEnabled = task.params?.pre_edit?.enabled === true;
  const apiKey = process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY;
  return Boolean(taskEnabled && apiKey);
}

function buildConservativeEditPrompt(role, userPrompt) {
  const shared = [
    "商品一致性铁律优先级最高，任何运营要求都不能覆盖它。",
    "请进行保守图像编辑，最大程度保留原始像素、主体身份、构图、真实纹理、颜色、材质、Logo、纽扣、花纹和边缘细节。",
    "不要重绘成另一张图，不要改变人物身份、五官、身材比例、服装款式、版型和颜色。",
    productFidelityRulesText(),
    "只允许做轻微清晰度提升、曝光/白平衡校正、背景清洁、去除水印或杂物、轻微锐化和电商图片质感优化。",
    "输出必须真实自然，适合服装电商详情页。"
  ].join("");
  if (role === "model") {
    return `${shared} 当前图片是真人模特图。请保持人物长相、发型、姿态和身体比例不变，只根据以下运营要求做轻微优化：${userPrompt}`;
  }
  return `${shared} 当前图片是服装商品图。请保持服装款式、颜色、材质、纹理、Logo、纽扣和版型不变，只根据以下运营要求做轻微优化：${userPrompt}`;
}

async function callAliyunImageEdit({ imageUrl, role, task, index }) {
  if (!imageUrl || !isRemoteUrl(imageUrl)) return imageUrl;
  const apiKey = process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return imageUrl;
  const baseUrl = (process.env.ALIYUN_DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
  const model = task.params?.pre_edit?.model || process.env.ALIYUN_PRE_EDIT_MODEL || "qwen-image-edit-plus";
  const size = role === "model"
    ? (process.env.ALIYUN_PRE_EDIT_MODEL_SIZE || "720*1280")
    : (process.env.ALIYUN_PRE_EDIT_GARMENT_SIZE || "1024*1024");
  const prompt = buildConservativeEditPrompt(role, task.params?.pre_edit?.prompt || "");

  const payload = await fetchWithTimeout(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [
              { image: imageUrl },
              { text: prompt }
            ]
          }
        ]
      },
      parameters: {
        n: 1,
        watermark: false,
        prompt_extend: false,
        size,
        negative_prompt: process.env.ALIYUN_PRE_EDIT_NEGATIVE_PROMPT || "low resolution, blurry, distorted face, changed identity, changed garment style, changed color, wrong logo, extra fingers, bad anatomy, watermark"
      }
    })
  });

  const editedUrl = extractQwenEditImageUrl(payload);
  if (!editedUrl) return imageUrl;
  const localUrl = await downloadRemoteMediaToLocal(task, `${role}-${index}`, editedUrl, "image");
  task.stage_timings[`pre_edit_${role}`] = {
    model,
    source_url: imageUrl,
    edited_url: editedUrl,
    local_url: localUrl
  };
  // Use the public DashScope result URL for the next model call; local URL is kept for audit/preview.
  return editedUrl;
}

async function maybePreEditTryOnInputs(task, context, input) {
  if (!shouldPreEdit(task)) return input;
  const editedInput = { ...input };
  reportTaskStage(task, "pre_editing", task.active_progress?.preEdit || 22, `第 ${(task.active_generation_index || 0) + 1}/${task.active_generation_count || 1} 张：正在做试衣前素材改图`);
  if (input.person_image_url) {
    editedInput.person_image_url = await callAliyunImageEdit({
      imageUrl: input.person_image_url,
      role: "model",
      task,
      index: "person"
    });
  }
  if (input.top_garment_url) {
    editedInput.top_garment_url = await callAliyunImageEdit({
      imageUrl: input.top_garment_url,
      role: "garment",
      task,
      index: "top"
    });
  }
  if (input.bottom_garment_url) {
    editedInput.bottom_garment_url = await callAliyunImageEdit({
      imageUrl: input.bottom_garment_url,
      role: "garment",
      task,
      index: "bottom"
    });
  }
  return editedInput;
}

function isAliyunSuccess(status) {
  return ["SUCCEEDED", "succeeded", "success", "completed"].includes(status);
}

function isAliyunFailure(status) {
  return ["FAILED", "failed", "CANCELED", "canceled", "UNKNOWN"].includes(status);
}

function mapAliyunGarmentInput(garment, input) {
  const slot = garment?.tryon_slot || (garment?.category === "pants" ? "bottom" : "top");
  if (slot === "bottom") {
    input.bottom_garment_url = garment.file_url || garment.preview_url;
  } else {
    input.top_garment_url = garment?.file_url || garment?.preview_url;
  }
}

function buildTryOnPrompt(context, task) {
  const category = context.garment?.category_label || context.garment?.category || "服装";
  const retryFeedback = task.active_retry_feedback;
  return [
    `请将目标${category}穿到真人模特身上，必须严格遵守商品一致性铁律。`,
    "目标服装图是唯一商品真值，不是风格参考。输出图必须让业务方一眼判断为同一件服装商品。",
    productFidelityRulesText(),
    "只能调整服装与人体贴合关系，不得重新设计服装，不得改变目标服装颜色、版型、衣长、装饰细节和纹理。若美化和一致性冲突，必须牺牲美化保留一致性。",
    retryFeedback ? `上一次生成失败原因：${retryFeedback}。本次必须针对该问题修正，不能重复同样错误。` : ""
  ].filter(Boolean).join("\n");
}

async function callAliyunImageTryOn(task, context, index) {
  const apiKey = process.env.ALIYUN_DASHSCOPE_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!apiKey) return mockImageResult(task, index);

  const personUrl = context.model?.file_url || context.model?.preview_url || process.env.ALIYUN_DEFAULT_PERSON_IMAGE_URL;
  const garmentUrl = context.garment?.file_url || context.garment?.preview_url || process.env.ALIYUN_DEFAULT_GARMENT_IMAGE_URL;

  // DashScope AI try-on requires public HTTP/HTTPS image URLs. Local data URLs cannot be used directly.
  if (!isRemoteUrl(personUrl) || !isRemoteUrl(garmentUrl)) {
    throw new Error("阿里百炼试衣需要公网 HTTP/HTTPS 人物图和服装图，请上传真人模特图并确认 OSS 上传成功。");
  }

  const baseUrl = (process.env.ALIYUN_DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com").replace(/\/$/, "");
  const createPath = process.env.ALIYUN_TRYON_CREATE_PATH || "/api/v1/services/aigc/image2image/image-synthesis";
  const model = process.env.ALIYUN_TRYON_MODEL || "aitryon-plus";
  const input = { person_image_url: personUrl };
  mapAliyunGarmentInput(context.garment, input);
  const effectiveInput = await maybePreEditTryOnInputs(task, context, input);

  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在虚拟试衣中`);
  const createPayload = await fetchWithTimeout(`${baseUrl}${createPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-Async": "enable"
    },
    body: JSON.stringify({
      model,
      input: effectiveInput,
      parameters: {
        resolution: Number(process.env.ALIYUN_TRYON_RESOLUTION || -1),
        restore_face: process.env.ALIYUN_TRYON_RESTORE_FACE !== "false",
        prompt: buildTryOnPrompt(context, task),
        negative_prompt: [
          process.env.ALIYUN_TRYON_NEGATIVE_PROMPT || "",
          "change garment color, alter dress length, shorten skirt, change waistline, redesign embroidery, remove lace, remove sequins, wrong texture, wrong pattern, changed silhouette, different garment"
        ].filter(Boolean).join(", ")
      }
    })
  });

  const taskId = extractAliyunTaskId(createPayload);
  if (!taskId) throw new Error("Aliyun DashScope did not return task_id");

  const maxPolls = Number(process.env.ALIYUN_MAX_POLLS || process.env.AI_PROVIDER_MAX_POLLS || 120);
  const intervalMs = Number(process.env.ALIYUN_POLL_INTERVAL_MS || process.env.AI_PROVIDER_POLL_INTERVAL_MS || 3000);
  let finalPayload = null;
  for (let i = 0; i < maxPolls; i += 1) {
    const payload = await fetchWithTimeout(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const status = extractAliyunStatus(payload);
    if (isAliyunSuccess(status)) {
      finalPayload = payload;
      break;
    }
    if (isAliyunFailure(status)) {
      throw new Error(payload.output?.message || payload.message || "Aliyun try-on task failed");
    }
    await sleep(intervalMs);
  }

  if (!finalPayload) throw new Error("Aliyun try-on task polling timeout");
  const imageUrl = extractAliyunImageUrl(finalPayload);
  if (!imageUrl) throw new Error("Aliyun DashScope did not return image_url");

  reportTaskStage(task, "effect_validating", task.active_progress?.validate || 76, `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：正在检查基础试衣是否生效`);
  let coarseEffectValidation = null;
  try {
    coarseEffectValidation = await validateTryOnEffectWithVision({
      task,
      context,
      aiResult: {
        provider: "aliyun",
        media_type: "image",
        image_url: imageUrl,
        cover_url: imageUrl,
        model_meta: { image_model: `aliyun/${model}`, provider_task_id: taskId }
      }
    });
    task.stage_timings[`tryon_effect_validate_${index}_coarse`] = coarseEffectValidation;
  } catch (error) {
    task.stage_timings[`tryon_effect_validate_${index}_coarse_error`] = {
      error: error?.message || String(error),
      at: new Date().toISOString()
    };
  }
  const coarseEffectFailed = coarseEffectValidation && coarseEffectValidation.passed === false && Number(coarseEffectValidation.confidence || 0) >= 0.55;
  const refinerEnabled = task.params?.refiner?.enabled !== false && process.env.ALIYUN_TRYON_ENABLE_REFINER === "true";
  const finalImageUrl = !coarseEffectFailed && refinerEnabled
    ? await callAliyunTryOnRefiner({
        task,
        context,
        index,
        baseUrl,
        createPath,
        apiKey,
        coarseImageUrl: imageUrl,
        input: effectiveInput
      })
    : imageUrl;

  const localUrl = await downloadRemoteMediaToLocal(task, index, finalImageUrl, "image");
  const refinerSkipped = coarseEffectFailed && refinerEnabled;
  const refinerDisabled = task.params?.refiner?.enabled === false && process.env.ALIYUN_TRYON_ENABLE_REFINER === "true";
  return {
    provider: "aliyun",
    media_type: "image",
    image_url: localUrl,
    cover_url: localUrl,
    model_meta: {
      image_model: !refinerSkipped && refinerEnabled ? `aliyun/${model}+aitryon-refiner` : `aliyun/${model}`,
      provider_task_id: taskId,
      ...(coarseEffectValidation ? {
        tryon_effect_validator: coarseEffectValidation.model,
        tryon_effect_validation: coarseEffectValidation
      } : {}),
      ...(refinerSkipped ? {
        refiner_skipped: true,
        refiner_skip_reason: "基础试衣未明显生效，跳过试衣图精修以避免成本浪费。"
      } : {}),
      ...(refinerDisabled ? {
        refiner_skipped: true,
        refiner_skip_reason: "用户已关闭试衣图精修。"
      } : {})
    }
  };
}

async function callAliyunTryOnRefiner({ task, context, baseUrl, createPath, apiKey, coarseImageUrl, input }) {
  if (task.params?.refiner?.enabled === false) return coarseImageUrl;
  reportTaskStage(task, "tryon_refining", task.active_progress?.refine || 62, `第 ${(task.active_generation_index || 0) + 1}/${task.active_generation_count || 1} 张：正在进行试衣图精修`);
  const refinerModel = process.env.ALIYUN_REFINER_MODEL || "aitryon-refiner";
  const gender = context.model?.gender === "male" ? "man" : "woman";
  const refinerInput = {
    person_image_url: input.person_image_url,
    coarse_image_url: coarseImageUrl
  };
  if (input.top_garment_url) refinerInput.top_garment_url = input.top_garment_url;
  if (input.bottom_garment_url) refinerInput.bottom_garment_url = input.bottom_garment_url;
  refinerInput.prompt = [
    "请只做保守精修，商品一致性铁律高于清晰度和美化。必须保持粗试衣结果中的目标服装与原商品图完全一致。",
    productFidelityRulesText(),
    "不得改变颜色、衣长、三围比例、腰线、裙摆廓形、装饰细节和纹理。不要添加不存在的袖子、内搭、饰物或新的设计元素。"
  ].join("\n");

  const createPayload = await fetchWithTimeout(`${baseUrl}${createPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-Async": "enable"
    },
    body: JSON.stringify({
      model: refinerModel,
      input: refinerInput,
      parameters: {
        gender,
        prompt: refinerInput.prompt,
        negative_prompt: "change garment color, alter dress length, redesign embroidery, wrong texture, different garment, changed silhouette"
      }
    })
  });

  const taskId = extractAliyunTaskId(createPayload);
  if (!taskId) throw new Error("Aliyun refiner did not return task_id");

  const maxPolls = Number(process.env.ALIYUN_REFINER_MAX_POLLS || process.env.ALIYUN_MAX_POLLS || process.env.AI_PROVIDER_MAX_POLLS || 120);
  const intervalMs = Number(process.env.ALIYUN_REFINER_POLL_INTERVAL_MS || process.env.ALIYUN_POLL_INTERVAL_MS || process.env.AI_PROVIDER_POLL_INTERVAL_MS || 3000);
  let finalPayload = null;
  for (let i = 0; i < maxPolls; i += 1) {
    const payload = await fetchWithTimeout(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    const status = extractAliyunStatus(payload);
    if (isAliyunSuccess(status)) {
      finalPayload = payload;
      break;
    }
    if (isAliyunFailure(status)) {
      throw new Error(payload.output?.message || payload.message || "Aliyun try-on refiner task failed");
    }
    await sleep(intervalMs);
  }

  if (!finalPayload) throw new Error("Aliyun try-on refiner polling timeout");
  const imageUrl = extractAliyunImageUrl(finalPayload);
  if (!imageUrl) throw new Error("Aliyun refiner did not return image_url");
  task.stage_timings.refiner_provider_task_id = taskId;
  return imageUrl;
}

function mockImageResult(task, index) {
  return {
    provider: "mock",
    media_type: "image",
    image_url: `/v1/media/results/${task.id}/${index}.svg`,
    cover_url: `/v1/media/results/${task.id}/${index}.svg?cover=1`,
    model_meta: {
      image_model: "tryon-image-mock-v1",
      provider_task_id: null
    }
  };
}

function mockVideoResult(task, index) {
  return {
    provider: "mock",
    media_type: "video",
    video_url: `/v1/media/results/${task.id}/${index}.mp4`,
    cover_url: `/v1/media/results/${task.id}/${index}.svg?cover=1`,
    duration_seconds: Number(task.params?.video?.duration_seconds || 15),
    model_meta: {
      video_model: "tryon-video-mock-v1",
      provider_task_id: null
    }
  };
}

async function callCustomImageTryOn(task, context, index) {
  const url = process.env.TRYON_IMAGE_API_URL;
  const token = process.env.TRYON_IMAGE_API_KEY;
  if (!url) return mockImageResult(task, index);

  const payload = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      task_id: task.id,
      garment: context.garment,
      model: context.model,
      prompt: task.prompt,
      params: task.params,
      index
    })
  });

  return {
    provider: "custom-image-tryon",
    media_type: "image",
    image_url: payload.image_url || payload.output_url || mockImageResult(task, index).image_url,
    cover_url: payload.cover_url || payload.image_url || payload.output_url || mockImageResult(task, index).cover_url,
    model_meta: {
      image_model: payload.model || "custom-image-tryon",
      provider_task_id: payload.id || payload.task_id || null
    }
  };
}

async function pollProviderTask({ statusUrl, headers, resultPath = "output_url" }) {
  const maxPolls = Number(process.env.AI_PROVIDER_MAX_POLLS || 90);
  const intervalMs = Number(process.env.AI_PROVIDER_POLL_INTERVAL_MS || 3000);
  for (let i = 0; i < maxPolls; i += 1) {
    const payload = await fetchWithTimeout(statusUrl, { headers }, DEFAULT_TIMEOUT_MS);
    const status = payload.status || payload.state;
    if (["completed", "succeeded", "success", "SUCCEEDED"].includes(status)) {
      const result = resultPath.split(".").reduce((obj, key) => obj && obj[key], payload);
      return { payload, result };
    }
    if (["failed", "error", "cancelled", "FAILED"].includes(status)) {
      throw new Error(payload.message || payload.error || "AI provider task failed");
    }
    await sleep(intervalMs);
  }
  throw new Error("AI provider task polling timeout");
}

async function callRunwayVideo(task, context, index) {
  const apiKey = process.env.RUNWAY_API_KEY;
  if (!apiKey) return mockVideoResult(task, index);

  const model = process.env.RUNWAY_VIDEO_MODEL || "gen4_turbo";
  const baseUrl = process.env.RUNWAY_API_BASE_URL || "https://api.dev.runwayml.com";
  const promptImage = context.bestImageUrl || context.garment?.preview_url || context.garment?.file_url;
  if (!promptImage || promptImage.startsWith("data:")) {
    return mockVideoResult(task, index);
  }

  const createPayload = await fetchWithTimeout(`${baseUrl}/v1/image_to_video`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "X-Runway-Version": process.env.RUNWAY_API_VERSION || "2024-11-06"
    },
    body: JSON.stringify({
      model,
      promptImage,
      promptText: task.prompt || "Fashion model wearing the provided garment, subtle turn, clean studio lighting.",
      ratio: task.params?.video?.ratio || "9:16",
      duration: Number(task.params?.video?.duration_seconds || 10)
    })
  });

  const providerTaskId = createPayload.id || createPayload.task_id;
  const output = createPayload.output?.[0] || createPayload.output_url || createPayload.video_url;
  if (output) {
    return {
      provider: "runway",
      media_type: "video",
      video_url: output,
      cover_url: context.bestImageUrl || mockVideoResult(task, index).cover_url,
      duration_seconds: Number(task.params?.video?.duration_seconds || 10),
      model_meta: { video_model: model, provider_task_id: providerTaskId || null }
    };
  }

  if (!providerTaskId) return mockVideoResult(task, index);
  const { payload } = await pollProviderTask({
    statusUrl: `${baseUrl}/v1/tasks/${providerTaskId}`,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Runway-Version": process.env.RUNWAY_API_VERSION || "2024-11-06"
    },
    resultPath: "output.0"
  });

  return {
    provider: "runway",
    media_type: "video",
    video_url: payload.output?.[0] || payload.output_url || payload.video_url || mockVideoResult(task, index).video_url,
    cover_url: context.bestImageUrl || mockVideoResult(task, index).cover_url,
    duration_seconds: Number(task.params?.video?.duration_seconds || 10),
    model_meta: { video_model: model, provider_task_id: providerTaskId }
  };
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createKlingJwt() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: accessKey,
    exp: nowSeconds + Number(process.env.KLING_JWT_TTL_SECONDS || 1800),
    nbf: nowSeconds - 5
  };
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function getKlingAuthHeader() {
  const bearerToken = process.env.KLING_API_KEY || createKlingJwt();
  if (!bearerToken) return null;
  return `Bearer ${bearerToken}`;
}

function normalizeKlingDuration(value) {
  const duration = Number(value || 5);
  if (duration <= 6) return "5";
  return "10";
}

function normalizeKlingRatio(value) {
  return value || "9:16";
}

function extractKlingTaskId(payload) {
  return payload.task_id || payload.id || payload.data?.task_id || payload.data?.id || payload.task_info?.id;
}

function extractKlingStatus(payload) {
  return (
    payload.status ||
    payload.task_status ||
    payload.data?.task_status ||
    payload.data?.status ||
    payload.task_info?.status ||
    payload.state
  );
}

function extractKlingVideoUrl(payload) {
  return (
    payload.url ||
    payload.video_url ||
    payload.output_url ||
    payload.data?.url ||
    payload.data?.video_url ||
    payload.data?.output_url ||
    payload.data?.task_result?.videos?.[0]?.url ||
    payload.task_result?.videos?.[0]?.url ||
    payload.output?.[0] ||
    payload.data?.output?.[0]
  );
}

function isKlingSuccess(status) {
  return ["succeed", "succeeded", "success", "completed", "complete", "SUCCEED"].includes(status);
}

function isKlingFailure(status) {
  return ["failed", "failure", "error", "cancelled", "canceled", "FAILED"].includes(status);
}

async function resolveKlingImageInput(value) {
  if (isRemoteUrl(value) || isDataUrl(value)) return value;
  const localPath = localMediaPathFromUrl(value);
  if (localPath && fs.existsSync(localPath)) return fileToDataUrl(localPath);
  return value;
}

async function callKlingVideo(task, context, index) {
  const authHeader = getKlingAuthHeader();
  if (!authHeader) return mockVideoResult(task, index);

  const baseUrl = (process.env.KLING_API_BASE_URL || "https://api.klingai.com").replace(/\/$/, "");
  const createPath = process.env.KLING_IMAGE2VIDEO_PATH || "/v1/videos/image2video";
  const statusPathTemplate = process.env.KLING_STATUS_PATH_TEMPLATE || "/v1/videos/image2video/{task_id}";
  const modelName = process.env.KLING_VIDEO_MODEL || "kling-v1-6";
  const mode = process.env.KLING_MODE || "std";
  const image = await resolveKlingImageInput(context.bestImageUrl || context.garment?.preview_url || context.garment?.file_url);

  if (!image) return mockVideoResult(task, index);

  const createPayload = await fetchWithTimeout(`${baseUrl}${createPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader
    },
    body: JSON.stringify({
      model_name: modelName,
      mode,
      image,
      prompt: task.prompt || "The fashion model makes a subtle turn, clean studio lighting, preserve garment texture.",
      negative_prompt: process.env.KLING_NEGATIVE_PROMPT || "distorted body, flickering clothes, warped hands, blurry face",
      aspect_ratio: normalizeKlingRatio(task.params?.video?.ratio),
      duration: normalizeKlingDuration(task.params?.video?.duration_seconds),
      cfg_scale: Number(process.env.KLING_CFG_SCALE || 0.5)
    })
  });

  const taskId = extractKlingTaskId(createPayload);
  const immediateUrl = extractKlingVideoUrl(createPayload);
  if (immediateUrl) {
    const localUrl = await downloadRemoteMediaToLocal(task, index, immediateUrl, "video");
    return {
      provider: "kling",
      media_type: "video",
      video_url: localUrl,
      cover_url: context.bestImageUrl || mockVideoResult(task, index).cover_url,
      duration_seconds: Number(task.params?.video?.duration_seconds || 10),
      model_meta: { video_model: modelName, provider_task_id: taskId || null }
    };
  }

  if (!taskId) throw new Error("Kling did not return task_id");

  const maxPolls = Number(process.env.KLING_MAX_POLLS || process.env.AI_PROVIDER_MAX_POLLS || 90);
  const intervalMs = Number(process.env.KLING_POLL_INTERVAL_MS || process.env.AI_PROVIDER_POLL_INTERVAL_MS || 3000);
  let finalPayload = null;
  for (let i = 0; i < maxPolls; i += 1) {
    const statusPath = statusPathTemplate.replace("{task_id}", encodeURIComponent(taskId));
    const payload = await fetchWithTimeout(`${baseUrl}${statusPath}`, {
      headers: { Authorization: authHeader }
    });
    const status = extractKlingStatus(payload);
    if (isKlingSuccess(status)) {
      finalPayload = payload;
      break;
    }
    if (isKlingFailure(status)) {
      throw new Error(payload.message || payload.data?.message || payload.error?.message || "Kling video task failed");
    }
    await sleep(intervalMs);
  }

  if (!finalPayload) throw new Error("Kling video task polling timeout");
  const videoUrl = extractKlingVideoUrl(finalPayload);
  if (!videoUrl) throw new Error("Kling did not return video URL");

  const localUrl = await downloadRemoteMediaToLocal(task, index, videoUrl, "video");
  return {
    provider: "kling",
    media_type: "video",
    video_url: localUrl,
    cover_url: context.bestImageUrl || mockVideoResult(task, index).cover_url,
    duration_seconds: Number(task.params?.video?.duration_seconds || 10),
    model_meta: { video_model: modelName, provider_task_id: taskId }
  };
}

async function callOpenAICompatibleVideo(task, context, index, providerName) {
  const apiKeyName = `${providerName.toUpperCase()}_API_KEY`;
  const baseUrlName = `${providerName.toUpperCase()}_API_BASE_URL`;
  const modelName = `${providerName.toUpperCase()}_VIDEO_MODEL`;
  const apiKey = process.env[apiKeyName];
  const baseUrl = process.env[baseUrlName];
  if (!apiKey || !baseUrl) return mockVideoResult(task, index);

  const model = process.env[modelName] || `${providerName}-video`;
  const payload = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/v1/video/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt: task.prompt || "Fashion model wearing the garment, subtle turn, clean studio lighting.",
      image: context.bestImageUrl || context.garment?.preview_url || context.garment?.file_url,
      size: task.params?.video?.ratio === "16:9" ? "1280x720" : "720x1280",
      duration: Number(task.params?.video?.duration_seconds || 10)
    })
  });

  return {
    provider: providerName,
    media_type: "video",
    video_url: payload.video_url || payload.output_url || payload.data?.[0]?.url || mockVideoResult(task, index).video_url,
    cover_url: payload.cover_url || context.bestImageUrl || mockVideoResult(task, index).cover_url,
    duration_seconds: Number(task.params?.video?.duration_seconds || 10),
    model_meta: {
      video_model: model,
      provider_task_id: payload.id || payload.task_id || null
    }
  };
}

async function callGptImageTryOn(task, context, index) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for GPT-Image try-on.");
  }

  const modelPhotoUrl = context.model?.file_url || context.model?.preview_url;
  const modelPhoto = await localOrRemoteImageToBlob(modelPhotoUrl);
  if (!modelPhoto) {
    throw new Error("GPT-Image try-on requires an accessible model photo.");
  }

  const garmentReferences = [];
  for (const source of garmentReferenceInputs(context)) {
    const image = await localOrRemoteImageToBlob(source.url);
    if (image) garmentReferences.push({ ...source, ...image });
  }
  if (!garmentReferences.length) {
    throw new Error("GPT-Image try-on requires at least one garment reference image.");
  }

  const model = process.env.OPENAI_IMAGE_OPTIMIZER_MODEL || "gpt-image-1.5";
  const size = process.env.GPT_IMAGE_TRYON_SIZE || process.env.OPENAI_IMAGE_OPTIMIZER_SIZE || "1024x1536";
  const quality = process.env.GPT_IMAGE_TRYON_QUALITY || "high";
  const outputFormat = process.env.GPT_IMAGE_TRYON_OUTPUT_FORMAT || "png";
  const endpoint = process.env.OPENAI_IMAGE_EDIT_URL || "https://api.302.ai/v1/images/edits";

  reportTaskStage(task, "virtual_tryon", task.active_progress?.tryon || 42,
    `第 ${(task.active_generation_index || index) + 1}/${task.active_generation_count || 1} 张：GPT-Image 正在生成试穿图`);

  const maxAttempts = Math.max(1, Number(process.env.GPT_IMAGE_TRYON_MAX_RETRIES || 2));
  let payload = null;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", buildGptImageTryOnPrompt(task, context));
    form.append("image", modelPhoto.blob, modelPhoto.fileName);
    garmentReferences.forEach((reference, refIdx) => {
      const fileBase = refIdx === 0 ? "garment-front-reference" : `garment-detail-reference-${refIdx}`;
      form.append("image", reference.blob, `${fileBase}.${extensionFromContentType(reference.blob.type)}`);
    });
    form.append("size", size);
    form.append("quality", quality);
    form.append("n", "1");
    form.append("output_format", outputFormat);
    form.append("background", "opaque");
    form.append("input_fidelity", process.env.GPT_IMAGE_TRYON_INPUT_FIDELITY || "high");

    try {
      payload = await fetchWithTimeout(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      }, Number(process.env.GPT_IMAGE_TRYON_TIMEOUT_MS || 360000));
      task.stage_timings[`gpt_image_tryon_${index}_attempts`] = attempt;
      break;
    } catch (error) {
      lastError = error;
      task.stage_timings[`gpt_image_tryon_${index}_attempt_${attempt}_error`] = {
        error: error?.message || String(error),
        status: error?.status || null,
        at: new Date().toISOString()
      };
      if (attempt >= maxAttempts || !shouldRetryImageOptimizer(error)) throw error;
      await sleep(Number(process.env.GPT_IMAGE_TRYON_RETRY_INTERVAL_MS || 3000) * attempt);
    }
  }
  if (!payload && lastError) throw lastError;

  const image = extractOpenAIImage(payload);
  if (!image) {
    throw new Error("GPT-Image try-on did not return an output image.");
  }

  let resultUrl;
  if (isRemoteUrl(image)) {
    resultUrl = await downloadRemoteMediaToLocal(task, `gpt-image-tryon-${index}`, image, "image");
  } else {
    resultUrl = saveProviderImage(task, `gpt-image-tryon-${index}`, Buffer.from(image, "base64"), `image/${outputFormat}`);
  }

  return {
    provider: "gpt-image-tryon",
    media_type: "image",
    image_url: resultUrl,
    cover_url: resultUrl,
    model_meta: {
      image_model: "gpt-image-1.5 (primary try-on)",
      tryon_provider: "gpt-image:try-on",
      gpt_image_tryon_size: size,
      gpt_image_tryon_quality: quality,
      gpt_image_tryon_reference_count: garmentReferences.length,
      gpt_image_tryon_detail_reference_count: Math.max(0, garmentReferences.length - 1),
      provider_task_id: null
    }
  };
}

async function generateTryOnImage(task, context, index) {
  const selected = String(task.params?.image?.tryon_model || "").toLowerCase();
  if (selected === "gpt-image:try-on" || selected === "gpt-image:tryon" || selected === "gpt-image") {
    return callGptImageTryOn(task, context, index);
  }
  if (selected === "pixelcut:try-on" || selected === "pixelcut:tryon" || selected === "pixelcut") {
    return callPixelcutTryOn(task, context, index);
  }
  if (selected === "302:fashn-tryon" || selected === "302:fashn-tryon-v1.5" || selected === "302-ai:fashn-tryon") {
    return call302FashnTryOn(task, context, index);
  }
  if (selected === "pixazo:fashn-vton" || selected === "pixazo:idm-vton" || selected === "pixazo:dm-vton" || selected === "dm-vton") {
    return callPixazoFashnVton(task, context, index);
  }
  if (selected === "replicate:idm-vton" || selected === "idm-vton") {
    return callReplicateIdmVton(task, context, index);
  }
  if (selected === "aliyun:aitryon-plus" || selected === "aliyun-plus") {
    return callAliyunImageTryOn(task, context, index);
  }
  const provider = (process.env.AI_IMAGE_PROVIDER || "mock").toLowerCase();
  if (provider === "aliyun" || provider === "dashscope") {
    return callAliyunImageTryOn(task, context, index);
  }
  if (provider === "segmind") {
    return callSegmindImageTryOn(task, context, index);
  }
  if (provider === "http" || provider === "custom") {
    return callCustomImageTryOn(task, context, index);
  }
  return mockImageResult(task, index);
}

async function generateTryOnVideo(task, context, index) {
  const provider = (process.env.AI_VIDEO_PROVIDER || "mock").toLowerCase();
  if (provider === "runway") return callRunwayVideo(task, context, index);
  if (provider === "kling") return callKlingVideo(task, context, index);
  if (provider === "luma") return callOpenAICompatibleVideo(task, context, index, provider);
  if (provider === "http" || provider === "custom") {
    return callOpenAICompatibleVideo(task, context, index, "custom");
  }
  return mockVideoResult(task, index);
}

module.exports = {
  generateTryOnImage,
  generateTryOnVideo,
  optimizeImageWithOpenAI,
  callGptImageTryOn,
  classifyGarmentImage,
  assessFashnInputCompatibility,
  validateTryOnEffectWithVision
};
