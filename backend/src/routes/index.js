// HTTP route handlers
// Called by: server.js
// Depends on: store, all services, model-gateway, oss

const fs = require("fs");
const path = require("path");
const { readStore, writeStore, id, now, modelLibrary, findModelById, normalizeModelPayload, addEvent } = require("../store/store");
const { inferGarment, normalizeGarmentCategory, riskFromFile, isRemoteUrl, normalizeGarmentReferenceImages, normalizeUploadedFile, MAX_GARMENT_REFERENCE_IMAGES } = require("../services/garment");
const { validateAliyunTryonInputs, validateFashnTryonInputs } = require("../services/validation");
const { recommendParams, creditCost, apiCapabilities } = require("../services/agent");
const { scheduleTask, svgForResult } = require("../services/task-runner");
const { classifyGarmentImage } = require("../ai/model-gateway");
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

async function route(req, res) {
  if (req.method === "OPTIONS") { send(res, 204, {}); return; }

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
      id: id("model"), tenant_id: "tenant-demo", user_id: "user-demo", source: "library_upload",
      ...normalizeModelPayload({ ...body, file_url: fileUrl, preview_url: fileUrl }),
      file_url: fileUrl, preview_url: fileUrl,
      size_bytes: Number(body.file?.size || 0), mime_type: body.file?.type || null,
      object_key: body.file?.object_key || null, risk_flags,
      created_at: now(), updated_at: now()
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
      if (previous) { previous.deleted = false; previous.fields = fields; previous.updated_at = now(); }
      else { store.model_library_changes.push({ id: modelId, deleted: false, fields, updated_at: now() }); }
    } else {
      const index = store.model_assets.findIndex(item => item.id === modelId);
      if (index === -1) return notFound(res);
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
    if (activeTask) { send(res, 409, { error: "MODEL_IN_USE", message: "该模特有处理中的任务，暂不能移除。" }); return; }
    if (existing.source === "system") {
      const previous = store.model_library_changes.find(item => item.id === modelId);
      if (previous) { previous.deleted = true; previous.updated_at = now(); }
      else { store.model_library_changes.push({ id: modelId, deleted: true, fields: {}, updated_at: now() }); }
    } else {
      const index = store.model_assets.findIndex(item => item.id === modelId);
      if (index === -1) return notFound(res);
      store.model_assets[index].deleted_at = now();
    }
    if (store.model_assets.filter(item => !item.deleted_at).length === 0 && modelLibrary(store).length === 0) {
      send(res, 409, { error: "LAST_MODEL_NOT_REMOVABLE", message: "至少需要保留一个可用模特。" }); return;
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
      fileName: body.file_name, contentType: body.content_type || body.mime_type || "application/octet-stream",
      folder: body.asset_type === "model" ? "models" : "uploads"
    });
    if (token) { send(res, 200, { data: token }); return; }
    send(res, 200, { data: { upload_id: id("upload"), method: "demo-local-json", object_key: `tenant-demo/uploads/${Date.now()}-${body.file_name || "asset"}`, expires_in: 1800 } });
    return;
  }

  if (req.method === "POST" && pathname === "/v1/assets/upload-data-url") {
    try {
      const body = await parseBody(req);
      const token = await oss.uploadDataUrl({ dataUrl: body.data_url, fileName: body.file_name, folder: body.asset_type === "model" ? "models" : "uploads" });
      if (!token) { send(res, 503, { error: "OSS_NOT_CONFIGURED", message: "OSS 未配置，无法上传。" }); return; }
      send(res, 200, { data: token });
    } catch (error) {
      send(res, 502, { error: "OSS_UPLOAD_FAILED", message: `OSS 上传失败：${error.message}`, detail: { suggestion: "请确认 OSS AccessKey 权限包含 PutObject，并且 Bucket 名称、Endpoint、地域配置正确。" } });
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
      classifier = await classifyGarmentImage({ imageUrl: body.file?.url || body.file?.read_url || body.file?.data_url, fileName: body.file?.name, description: body.description });
    } catch (error) {
      classifier = { ...fallbackInferred, confidence: 0, source: "fallback", reason: `模型识别暂不可用，已使用文件名/文本兜底：${error.message}` };
    }
    const inferred = classifier && classifier.confidence >= 0.55 ? classifier : fallbackInferred;
    const risk_flags = riskFromFile(body.file);
    if (classifier?.fashn_input_risk === "high") {
      risk_flags.push({ code: "fashn_input_high_risk", level: "warn", message: `FASHN 输入风险较高：${classifier.fashn_risk_reason || "建议使用平铺、衣架或假人商品图。"}` });
    } else if (classifier?.fashn_input_risk === "medium") {
      risk_flags.push({ code: "fashn_input_medium_risk", level: "warn", message: `FASHN 输入存在一定风险：${classifier.fashn_risk_reason || "如果生成失败，请改用更干净的商品图。"}` });
    }
    const garment = {
      id: id("garment"), tenant_id: "tenant-demo", user_id: "user-demo",
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
    if (!garment) { send(res, 404, { error: "GARMENT_NOT_FOUND", message: "服装图不存在" }); return; }
    const normalized = normalizeGarmentCategory(body.category_key || body.category, garment);
    garment.category = normalized.category; garment.category_label = normalized.label;
    garment.category_key = normalized.key; garment.length = normalized.length;
    garment.tryon_slot = normalized.tryon_slot; garment.requires_full_body = Boolean(normalized.requires_full_body);
    garment.analysis = { ...(garment.analysis || {}), category_source: "user_confirmed", category_confidence: 1, category_reason: "用户在页面二次确认服装品类。" };
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
        id: id("model"), name: body.file?.name || "用户上传模特", source: "user_upload",
        gender: "unknown", body_type: "regular", pose_type: "full_body_standing",
        file_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
        preview_url: body.file?.url || body.file?.read_url || body.file?.data_url || null,
        size_bytes: Number(body.file?.size || 0), mime_type: body.file?.type || null,
        object_key: body.file?.object_key || null, preview_color: "#0f766e",
        risk_flags: riskFromFile(body.file)
      };
      store.model_assets.push({ ...model, tenant_id: "tenant-demo", user_id: "user-demo", created_at: now() });
      writeStore(store);
    }
    if (!model) { send(res, 404, { error: "MODEL_NOT_FOUND", message: "模特不存在" }); return; }
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
      send(res, 422, { error: "GARMENT_REFERENCE_LIMIT_EXCEEDED", message: `服装细节参考图最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张，任务未提交，未扣额度。`, detail: { code: "GARMENT_REFERENCE_LIMIT_EXCEEDED", userMessage: "服装细节参考图数量超过上限。", suggestion: `请保留最关键的背面、Logo、印花、面料、领口、袖口等参考图，最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张。` } });
      return;
    }
    const params = { ...rawParams, garment_references: normalizeGarmentReferenceImages(rawGarmentReferences) };
    const selectedTryonModel = params?.image?.tryon_model || "";

    if (needsImageTryon && (selectedTryonModel === "aliyun:aitryon-plus" || (process.env.AI_IMAGE_PROVIDER || "").toLowerCase() === "aliyun")) {
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
    if (needsImageTryon && (selectedTryonModel === "pixelcut:try-on" || selectedTryonModel === "pixelcut:tryon" || selectedTryonModel === "pixelcut") && !process.env.PIXELCUT_API_KEY) {
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
    if (needsImageTryon && (selectedTryonModel === "gpt-image:try-on" || selectedTryonModel === "gpt-image:tryon" || selectedTryonModel === "gpt-image")) {
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
    if (user.credit_balance < cost) { send(res, 402, { error: "INSUFFICIENT_CREDITS", message: "额度不足，无法提交生成任务。" }); return; }
    user.credit_balance -= cost;
    const task = {
      id: id("task"), tenant_id: "tenant-demo", user_id: "user-demo",
      garment_id: body.garment_id, model_id: body.model_id,
      output_type: body.output_type || "image", prompt: body.prompt || "",
      params, status: "pending", progress: 1, current_stage: "pending",
      message: "任务已提交", credit_cost: cost, failure_reason: null,
      stage_timings: { submitted_at: now() },
      created_at: now(), updated_at: now()
    };
    store.tasks.push(task);
    store.credit_logs.push({ id: id("credit"), tenant_id: "tenant-demo", user_id: "user-demo", task_id: task.id, amount: -cost, direction: "debit", reason: "precharge", status: "reserved", created_at: now() });
    addEvent(store, task.id, task.status, task.progress, task.message);
    writeStore(store);
    scheduleTask(task.id);
    send(res, 201, { data: task });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/tryon/tasks") {
    const store = readStore();
    const tasks = store.tasks.slice().reverse().map(task => ({ ...task, results: store.results.filter(result => result.task_id === task.id) }));
    send(res, 200, { data: tasks });
    return;
  }

  if (req.method === "GET" && pathname === "/v1/tryon/results") {
    const store = readStore();
    const rows = store.results.slice().reverse().map(result => {
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
    send(res, 200, { data: { ...task, results: store.results.filter(result => result.task_id === task.id), events: store.events.filter(event => event.task_id === task.id) } });
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
    send(res, 200, { data: { signed_url: result.media_type === "image" ? result.image_url : result.video_url, expires_in: 1800, file_name: `${result.id}.${result.media_type === "image" ? "svg" : "mp4"}` } });
    return;
  }

  const mediaMatch = pathname.match(/^\/v1\/media\/results\/([^/]+)\/(\d+)\.(svg|mp4)$/);
  if (req.method === "GET" && mediaMatch) {
    const [, taskId, index, ext] = mediaMatch;
    if (ext === "svg") { sendText(res, 200, svgForResult(taskId, Number(index)), "image/svg+xml; charset=utf-8"); return; }
    sendText(res, 200, "Demo MP4 placeholder. Replace Video Worker output with a real MP4 object URL in production.", "video/mp4");
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

  notFound(res);
}

module.exports = { route };
