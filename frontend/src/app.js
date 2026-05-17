const API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.hostname}:4000`;
const MIN_IMAGE_UPLOAD_BYTES = 5 * 1024;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
const PROVIDER_MAX_IMAGE_BYTES = 4.8 * 1024 * 1024;
const PROVIDER_MAX_IMAGE_EDGE = 3072;
const PROVIDER_MIN_IMAGE_EDGE = 151;
const MAX_GARMENT_REFERENCE_IMAGES = 10;
const GARMENT_CATEGORY_META = {
  camisole: { label: "吊带/背心", category: "shirt", requiresFullBody: false },
  base_layer: { label: "打底衫", category: "shirt", requiresFullBody: false },
  tshirt: { label: "T恤", category: "shirt", requiresFullBody: false },
  shirt: { label: "衬衫/上衣", category: "shirt", requiresFullBody: false },
  knitwear: { label: "针织衫/毛衣", category: "shirt", requiresFullBody: false },
  hoodie: { label: "卫衣", category: "shirt", requiresFullBody: false },
  jacket: { label: "夹克/外套", category: "shirt", requiresFullBody: false },
  coat: { label: "风衣/大衣", category: "shirt", requiresFullBody: true },
  down_jacket: { label: "羽绒服", category: "shirt", requiresFullBody: false },
  blazer: { label: "西装/开衫", category: "shirt", requiresFullBody: false },
  skirt: { label: "半身裙", category: "pants", requiresFullBody: true },
  shorts: { label: "短裤", category: "pants", requiresFullBody: true },
  pants: { label: "长裤/裤装", category: "pants", requiresFullBody: true },
  wide_leg_pants: { label: "阔腿裤/喇叭裤", category: "pants", requiresFullBody: true },
  leggings: { label: "紧身裤/瑜伽裤", category: "pants", requiresFullBody: true },
  dress: { label: "连衣裙", category: "dress", requiresFullBody: true },
  jumpsuit: { label: "连体裤/连体衣", category: "dress", requiresFullBody: true },
  swimsuit: { label: "连身泳衣", category: "dress", requiresFullBody: true },
  sleepwear: { label: "睡衣/家居服", category: "dress", requiresFullBody: true },
  underwear: { label: "内衣/塑身衣", category: "shirt", requiresFullBody: false },
  sportswear: { label: "运动上衣/冲锋衣/防晒衣", category: "shirt", requiresFullBody: false },
  formal_dress: { label: "婚纱/礼服", category: "dress", requiresFullBody: true },
  traditional: { label: "汉服/旗袍/和服", category: "dress", requiresFullBody: true },
  protective: { label: "围裙/实验服/雨衣", category: "shirt", requiresFullBody: false }
};

const state = {
  garment: null,
  garmentReferenceImages: [],
  selectedModel: null,
  models: [],
  capabilities: null,
  managedResults: [],
  resultFilter: "all",
  currentTaskId: null,
  pollTimer: null,
  expandedHistoryTaskId: null,
  historyPollTimer: null,
  libraryModelPreviewDataUrl: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(payload.message || payload.error || "请求失败");
    error.payload = payload;
    throw error;
  }
  return payload.data;
}

function setApiStatus(ok) {
  $(".status-dot").classList.toggle("ok", ok);
  $(".status-dot").classList.toggle("bad", !ok);
  $("#apiStatus").textContent = ok ? "后端已连接" : "后端未连接";
}

function qualityBadge(status) {
  const map = {
    recommended: ["推荐", "green"],
    usable: ["可用", "blue"],
    repair_needed: ["待修复", "amber"],
    unusable: ["不可用", "red"],
    failed: ["失败", "red"]
  };
  const item = map[status] || ["处理中", "muted"];
  return `<span class="badge ${item[1]}">${item[0]}</span>`;
}

function statusBadge(status) {
  if (status === "completed") return '<span class="badge green">已完成</span>';
  if (status === "failed") return '<span class="badge red">失败</span>';
  if (status === "partial_failed") return '<span class="badge amber">部分失败</span>';
  return '<span class="badge blue">处理中</span>';
}

function isTerminalStatus(status) {
  return ["completed", "partial_failed", "failed", "cancelled"].includes(status);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败，请更换图片"));
    };
    image.src = url;
  });
}

function canvasToDataUrl(canvas, quality) {
  return canvas.toDataURL("image/jpeg", quality);
}

function dataUrlSizeBytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.ceil(base64.length * 0.75);
}

async function normalizeImageForProvider(file) {
  const image = await loadImageFromFile(file);
  const originalWidth = image.naturalWidth || image.width;
  const originalHeight = image.naturalHeight || image.height;
  const minEdge = Math.min(originalWidth, originalHeight);
  const maxEdge = Math.max(originalWidth, originalHeight);
  if (minEdge < PROVIDER_MIN_IMAGE_EDGE) {
    throw new Error("图片最短边小于 150px，不符合模型要求，请更换更清晰的图片");
  }

  const scale = Math.min(1, PROVIDER_MAX_IMAGE_EDGE / maxEdge);
  const width = Math.max(PROVIDER_MIN_IMAGE_EDGE, Math.round(originalWidth * scale));
  const height = Math.max(PROVIDER_MIN_IMAGE_EDGE, Math.round(originalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);

  let quality = 0.92;
  let dataUrl = canvasToDataUrl(canvas, quality);
  while (dataUrlSizeBytes(dataUrl) > PROVIDER_MAX_IMAGE_BYTES && quality > 0.68) {
    quality -= 0.06;
    dataUrl = canvasToDataUrl(canvas, quality);
  }
  if (dataUrlSizeBytes(dataUrl) > PROVIDER_MAX_IMAGE_BYTES) {
    const shrink = Math.sqrt(PROVIDER_MAX_IMAGE_BYTES / dataUrlSizeBytes(dataUrl));
    const secondCanvas = document.createElement("canvas");
    secondCanvas.width = Math.max(PROVIDER_MIN_IMAGE_EDGE, Math.round(width * shrink));
    secondCanvas.height = Math.max(PROVIDER_MIN_IMAGE_EDGE, Math.round(height * shrink));
    const secondCtx = secondCanvas.getContext("2d", { alpha: false });
    secondCtx.fillStyle = "#ffffff";
    secondCtx.fillRect(0, 0, secondCanvas.width, secondCanvas.height);
    secondCtx.imageSmoothingEnabled = true;
    secondCtx.imageSmoothingQuality = "high";
    secondCtx.drawImage(canvas, 0, 0, secondCanvas.width, secondCanvas.height);
    dataUrl = canvasToDataUrl(secondCanvas, 0.86);
  }
  return {
    dataUrl,
    size: dataUrlSizeBytes(dataUrl),
    type: "image/jpeg",
    width: canvas.width,
    height: canvas.height,
    normalized: file.size > PROVIDER_MAX_IMAGE_BYTES || maxEdge >= 4096 || file.type !== "image/jpeg"
  };
}

async function loadHealth() {
  try {
    await api("/health");
    setApiStatus(true);
  } catch {
    setApiStatus(false);
  }
}

async function loadCapabilities() {
  try {
    state.capabilities = await api("/v1/system/capabilities");
    renderCapabilities();
  } catch {
    state.capabilities = null;
    renderCapabilities();
  }
}

function renderCapabilities() {
  const el = $("#apiCapability");
  const cap = state.capabilities;
  if (el) {
    if (!cap) {
      el.innerHTML = `<strong>API 能力边界</strong><span>暂未读取到后端能力，请确认服务已启动。</span>`;
    } else {
      el.innerHTML = `
        <strong>API 能力边界</strong>
        <span>试衣模型：${cap.tryon_model} · 输出参数：${cap.tryon_resolution === 1280 ? "720x1280" : cap.tryon_resolution}</span>
        <span>图改图：${cap.pre_edit_enabled ? "可选，默认关闭" : "未配置"} · 精修：${cap.refiner_enabled ? cap.refiner_model : "未启用"}</span>
        <span>最终商用出图：${cap.openai_image_optimizer_enabled ? `${cap.openai_image_optimizer_provider || "商用出图"} ${cap.openai_image_optimizer_model}` : "未配置"} · ${cap.openai_image_optimizer_size || ""}</span>
        <span>存储：${cap.oss_configured ? "OSS 已配置" : "本地演示"} · 推荐门槛：综合分 ${cap.commercial_quality.recommended_threshold}+</span>
      `;
    }
  }
  renderModelStack();
}

function renderModelStack() {
  const el = $("#modelStack");
  if (!el) return;
  const stack = state.capabilities?.model_stack || [];
  el.innerHTML = stack.length ? stack.map(item => `
    <article class="model-stack-card">
      <div>
        <strong>${item.name}</strong>
        <span>${item.provider}</span>
      </div>
      <p>${item.model}</p>
      <small>${item.purpose}</small>
      <span class="badge ${item.status === "启用" ? "green" : item.status === "待配置" ? "amber" : "muted"}">${item.status}</span>
    </article>
  `).join("") : `<div class="task-empty">暂未读取到模型配置</div>`;
}

async function loadCredits() {
  const data = await api("/v1/credits/balance");
  $("#creditBalance").textContent = data.balance;
}

function renderModels(target, models, selectable) {
  target.innerHTML = models.map(model => `
    <article class="model-card ${state.selectedModel?.id === model.id ? "selected" : ""}" data-model-id="${model.id}">
      <div class="model-avatar ${model.preview_url ? "has-photo" : ""}" ${model.preview_url ? "" : `style="background: linear-gradient(135deg, ${model.preview_color || "#2563eb"}, #f8fafc)"`}>
        ${model.preview_url ? `<img src="${mediaUrl(model.preview_url)}" alt="${model.name}">` : ""}
      </div>
      <h3>${model.name}</h3>
      <p>${model.gender === "female" ? "女模特" : model.gender === "male" ? "男模特" : "模特"} · ${model.body_type} · ${model.pose_type}</p>
      <p>适用：${(model.categories || []).join(" / ") || "通用"}</p>
    </article>
  `).join("");

  if (selectable) {
    target.querySelectorAll(".model-card").forEach(card => {
      card.addEventListener("click", async () => {
        const model = models.find(item => item.id === card.dataset.modelId);
        const validated = await api("/v1/models/validate", {
          method: "POST",
          body: JSON.stringify({ model_id: model.id })
        });
        state.selectedModel = validated;
        $("#modelState").textContent = "已选择";
        $("#modelState").className = "badge green";
        renderModels($("#modelGrid"), state.models, true);
        updateSubmitState();
        toast(`已选择 ${model.name}`);
      });
    });
  }
}

function renderModelLibrary() {
  const target = $("#modelLibrary");
  if (!target) return;
  target.innerHTML = state.models.map(model => `
    <article class="model-card library-card" data-model-id="${model.id}">
      <button class="model-avatar ${model.preview_url ? "has-photo" : ""}" data-preview-model="${model.id}" type="button" ${model.preview_url ? "" : `style="background: linear-gradient(135deg, ${model.preview_color || "#2563eb"}, #f8fafc)"`}>
        ${model.preview_url ? `<img src="${mediaUrl(model.preview_url)}" alt="${model.name}">` : ""}
      </button>
      <h3>${model.name}</h3>
      <p>${model.gender === "female" ? "女模特" : model.gender === "male" ? "男模特" : "模特"} · ${model.body_type} · ${model.pose_type}</p>
      <p>适用：${(model.categories || []).join(" / ") || "通用"}</p>
      <div class="library-card-meta">
        <span class="badge ${model.source === "system" ? "blue" : "green"}">${model.source === "system" ? "系统默认" : "自定义"}</span>
        ${model.video_enabled ? '<span class="badge green">视频可用</span>' : ""}
      </div>
      <div class="library-card-actions">
        <button class="secondary-btn" data-edit-library-model="${model.id}">修改</button>
        <button class="secondary-btn danger-btn" data-delete-library-model="${model.id}">移除</button>
      </div>
    </article>
  `).join("");

  target.querySelectorAll("[data-edit-library-model]").forEach(button => {
    button.addEventListener("click", () => {
      const model = state.models.find(item => item.id === button.dataset.editLibraryModel);
      if (model) fillModelLibraryForm(model);
    });
  });
  target.querySelectorAll("[data-preview-model]").forEach(button => {
    button.addEventListener("click", () => {
      const model = state.models.find(item => item.id === button.dataset.previewModel);
      if (model?.preview_url) openMediaModal({
        id: model.id,
        media_type: "image",
        image_url: model.preview_url,
        cover_url: model.preview_url
      });
    });
  });
  target.querySelectorAll("[data-delete-library-model]").forEach(button => {
    button.addEventListener("click", async () => {
      const model = state.models.find(item => item.id === button.dataset.deleteLibraryModel);
      if (!model) return;
      if (!window.confirm(`确认移除模特「${model.name}」吗？`)) return;
      try {
        await api(`/v1/models/system/${encodeURIComponent(model.id)}`, { method: "DELETE" });
        if (state.selectedModel?.id === model.id) state.selectedModel = null;
        resetModelLibraryForm();
        await loadModels();
        toast("模特已移除");
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

async function uploadAssetToOss(file, assetType) {
  if (file.size < MIN_IMAGE_UPLOAD_BYTES) {
    throw new Error("图片小于 5KB，不符合百炼试衣要求");
  }
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("图片超过 20MB，请压缩后上传");
  }
  const originalPreview = await fileToDataUrl(file);
  const normalized = await normalizeImageForProvider(file);
  if (normalized.size < MIN_IMAGE_UPLOAD_BYTES) {
    throw new Error("图片压缩后小于 5KB，请更换图片");
  }

  const relay = await api("/v1/assets/upload-data-url", {
    method: "POST",
    body: JSON.stringify({
      asset_type: assetType,
      file_name: file.name.replace(/\.[^.]+$/, "") + "-provider-ready.jpg",
      content_type: normalized.type,
      size: normalized.size,
      width: normalized.width,
      height: normalized.height,
      original_size: file.size,
      original_type: file.type || "application/octet-stream",
      data_url: normalized.dataUrl
    })
  });

  if (!relay.read_url) {
    throw new Error("后端未返回 OSS 图片地址");
  }

  return {
    dataUrl: originalPreview,
    uploadedFile: {
        name: file.name,
        size: normalized.size,
        original_size: file.size,
        type: normalized.type,
        width: normalized.width,
        height: normalized.height,
        normalized_for_provider: normalized.normalized,
      url: relay.read_url,
      object_key: relay.object_key
    }
  };
}

async function loadModels() {
  const models = await api("/v1/models/system");
  state.models = models;
  if (!state.selectedModel || !models.some(model => model.id === state.selectedModel.id)) {
    state.selectedModel = models[0] || null;
  } else {
    state.selectedModel = models.find(model => model.id === state.selectedModel.id);
  }
  $("#modelState").textContent = state.selectedModel ? "默认推荐" : "待选择";
  $("#modelState").className = state.selectedModel ? "badge blue" : "badge muted";
  renderModels($("#modelGrid"), models, true);
  renderModelLibrary();
  updateSubmitState();
}

function resetModelLibraryForm() {
  $("#modelLibraryForm").reset();
  $("#modelEditId").value = "";
  $("#libraryModelPreview").className = "preview small empty";
  $("#libraryModelPreview").textContent = "模特图";
  $("#libraryModelFileName").textContent = "未选择图片";
  $("#libraryModelMode").textContent = "新增模特";
  $("#saveLibraryModelBtn").textContent = "保存模特";
  state.libraryModelPreviewDataUrl = null;
}

function fillModelLibraryForm(model) {
  $("#modelEditId").value = model.id;
  $("#libraryModelName").value = model.name || "";
  $("#libraryModelGender").value = model.gender || "unknown";
  $("#libraryModelBody").value = model.body_type || "regular";
  $("#libraryModelPose").value = model.pose_type || "full_body_standing";
  $("#libraryModelCategories").value = (model.categories || []).join(", ");
  $("#libraryModelRisks").value = (model.risk_tags || []).join(", ");
  $("#libraryModelPreview").className = `preview small ${model.preview_url ? "" : "empty"}`;
  $("#libraryModelPreview").innerHTML = model.preview_url ? `<img src="${mediaUrl(model.preview_url)}" alt="${model.name}">` : "模特图";
  $("#libraryModelFileName").textContent = model.file_url ? "已有关联图片" : "未配置图片";
  $("#libraryModelMode").textContent = `正在修改：${model.name}`;
  $("#saveLibraryModelBtn").textContent = "保存修改";
  state.libraryModelPreviewDataUrl = null;
  $("#libraryModelInput").value = "";
  $("#modelsTab").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderGarmentReferenceImages() {
  const grid = $("#garmentDetailGrid");
  const meta = $("#garmentDetailMeta");
  if (!grid || !meta) return;
  meta.textContent = `${state.garmentReferenceImages.length}/${MAX_GARMENT_REFERENCE_IMAGES} 张细节参考图；仅用于最终商用出图，不传给试衣模型`;
  grid.innerHTML = state.garmentReferenceImages.map((item, index) => `
    <article class="detail-card">
      <img src="${item.preview_data_url || item.url}" alt="${item.name || `细节图${index + 1}`}">
      <span title="${item.name || ""}">${index + 1}. ${item.name || "细节参考图"}</span>
      <button type="button" data-remove-garment-reference="${index}">移除</button>
    </article>
  `).join("");
  grid.querySelectorAll("[data-remove-garment-reference]").forEach(button => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.removeGarmentReference);
      state.garmentReferenceImages.splice(index, 1);
      if (state.garment) state.garment.reference_images = state.garmentReferenceImages;
      renderGarmentReferenceImages();
      updateSubmitState();
    });
  });
}

async function handleGarmentDetailFiles(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  if (!files.length) return;
  if (state.garmentReferenceImages.length + files.length > MAX_GARMENT_REFERENCE_IMAGES) {
    toast(`细节参考图最多上传 ${MAX_GARMENT_REFERENCE_IMAGES} 张，请先移除部分图片。`);
    return;
  }
  $("#garmentDetailMeta").textContent = "正在上传细节参考图...";
  try {
    for (const file of files) {
      const uploaded = await uploadAssetToOss(file, "garment_reference");
      state.garmentReferenceImages.push({
        name: file.name,
        url: uploaded.uploadedFile.url || uploaded.uploadedFile.data_url,
        read_url: uploaded.uploadedFile.url || uploaded.uploadedFile.data_url,
        object_key: uploaded.uploadedFile.object_key || null,
        type: uploaded.uploadedFile.type,
        size: uploaded.uploadedFile.size,
        width: uploaded.uploadedFile.width,
        height: uploaded.uploadedFile.height,
        preview_data_url: uploaded.dataUrl
      });
    }
    if (state.garment) state.garment.reference_images = state.garmentReferenceImages;
    renderGarmentReferenceImages();
    updateSubmitState();
    toast("细节参考图已上传");
  } catch (error) {
    toast(`细节参考图上传失败：${error.message}`);
    renderGarmentReferenceImages();
  }
}

function taskGarmentReferencePayload() {
  return state.garmentReferenceImages.slice(0, MAX_GARMENT_REFERENCE_IMAGES).map(item => ({
    name: item.name,
    url: item.url || item.read_url,
    read_url: item.read_url || item.url,
    object_key: item.object_key || null,
    type: item.type || null,
    size: item.size || 0,
    width: item.width || 0,
    height: item.height || 0
  })).filter(item => item.url || item.read_url);
}

async function handleLibraryModelFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    state.libraryModelPreviewDataUrl = await fileToDataUrl(file);
    $("#libraryModelPreview").className = "preview small";
    $("#libraryModelPreview").innerHTML = `<img src="${state.libraryModelPreviewDataUrl}" alt="模特预览">`;
    $("#libraryModelFileName").textContent = `${file.name} · ${Math.round(file.size / 1024)} KB`;
  } catch (error) {
    toast(error.message);
  }
}

function collectLibraryModelFields(filePayload) {
  return {
    name: $("#libraryModelName").value.trim(),
    gender: $("#libraryModelGender").value,
    body_type: $("#libraryModelBody").value,
    pose_type: $("#libraryModelPose").value,
    categories: $("#libraryModelCategories").value,
    risk_tags: $("#libraryModelRisks").value,
    file: filePayload || undefined
  };
}

async function saveLibraryModel(event) {
  event.preventDefault();
  const editId = $("#modelEditId").value;
  const file = $("#libraryModelInput").files[0];
  if (!$("#libraryModelName").value.trim()) {
    toast("请填写模特名称");
    return;
  }
  let uploadedFile = null;
  try {
    if (file) {
      const uploaded = await uploadAssetToOss(file, "model");
      uploadedFile = uploaded.uploadedFile;
    }
    const payload = collectLibraryModelFields(uploadedFile);
    const saved = await api(editId ? `/v1/models/system/${encodeURIComponent(editId)}` : "/v1/models/system", {
      method: editId ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    state.selectedModel = saved;
    resetModelLibraryForm();
    await loadModels();
    toast(editId ? "模特已更新，并同步到新建任务页" : "模特已新增，并同步到新建任务页");
  } catch (error) {
    toast(error.message);
  }
}

function renderGarmentAnalysis(garment) {
  const sourceMap = {
    vision_model: "视觉模型",
    filename_rule: "规则兜底",
    fallback: "兜底识别"
  };
  const confidence = garment.analysis?.category_confidence
    ? `${Math.round(Number(garment.analysis.category_confidence) * 100)}%`
    : "待确认";
  $("#garmentAnalysis").innerHTML = `
    <div class="analysis-item"><span>品类</span><strong>${garment.category_label}</strong></div>
    <div class="analysis-item"><span>识别方式</span><strong>${sourceMap[garment.analysis?.category_source] || "自动识别"}</strong></div>
    <div class="analysis-item"><span>置信度</span><strong>${confidence}</strong></div>
    <div class="analysis-item"><span>清晰度</span><strong>${garment.analysis.clarity === "good" ? "通过" : "偏低"}</strong></div>
    <div class="analysis-item"><span>主体完整</span><strong>${garment.analysis.subject_integrity === "passed" ? "通过" : "风险"}</strong></div>
    <div class="analysis-item"><span>风险标签</span><strong>${garment.risk_flags.length ? garment.risk_flags.length + "项" : "无"}</strong></div>
  `;
  if (garment.analysis?.category_reason) {
    toast(`服装识别：${garment.category_label} · ${confidence}`);
  }
  if (garment.risk_flags.length) {
    toast(garment.risk_flags.map(item => item.message).join(" "));
  }
}

function showGarmentCategoryConfirm(garment) {
  const panel = $("#garmentCategoryConfirm");
  const select = $("#garmentCategorySelect");
  const hint = $("#garmentCategoryHint");
  if (!panel || !select || !garment) return;
  panel.classList.remove("hidden");
  select.disabled = false;
  select.value = garment.category_key || (garment.category === "pants" ? "pants" : garment.category === "dress" ? "dress" : "shirt");
  const meta = GARMENT_CATEGORY_META[select.value];
  hint.textContent = `${garment.analysis?.category_source === "vision_model" ? "模型默认识别" : "系统默认识别"}：${garment.category_label}。请确认后再提交，连衣裙/裤装建议选择全身模特。`;
  if (meta?.requiresFullBody && state.selectedModel?.pose_type === "half_body") {
    toast("当前服装需要全身模特，已检测到所选模特为半身照片，请更换全身模特。");
  }
}

async function confirmGarmentCategory() {
  if (!state.garment) return;
  const select = $("#garmentCategorySelect");
  const meta = GARMENT_CATEGORY_META[select.value];
  $("#garmentCategoryHint").textContent = "正在保存品类确认...";
  try {
    const garment = await api(`/v1/garments/${encodeURIComponent(state.garment.id)}/category`, {
      method: "PUT",
      body: JSON.stringify({ category_key: select.value })
    });
    state.garment = garment;
    renderGarmentAnalysis(garment);
    showGarmentCategoryConfirm(garment);
    updateSubmitState();
    toast(`已确认服装品类：${meta?.label || garment.category_label}`);
  } catch (error) {
    $("#garmentCategoryHint").textContent = "品类保存失败，请重试。";
    toast(error.message);
  }
}

async function handleGarmentFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const replacingGarment = Boolean(state.garment);
  let dataUrl;
  let uploadedFile;
  try {
    const uploaded = await uploadAssetToOss(file, "garment");
    dataUrl = uploaded.dataUrl;
    uploadedFile = uploaded.uploadedFile;
  } catch (error) {
    $("#garmentState").textContent = "上传失败";
    $("#garmentState").className = "badge red";
    toast(`服装图上传失败：${error.message}`);
    return;
  }
  if (replacingGarment && state.garmentReferenceImages.length) {
    state.garmentReferenceImages = [];
    renderGarmentReferenceImages();
    toast("已更换服装正面图，旧细节参考图已清空，请重新上传同一件衣服的细节图。");
  }
  $("#garmentPreview").innerHTML = `<img src="${dataUrl}" alt="服装预览">`;
  $("#garmentName").textContent = file.name;
  $("#garmentMeta").textContent = uploadedFile.normalized_for_provider
    ? `${Math.round(file.size / 1024)} KB · 已自动生成模型合规图 ${Math.round(uploadedFile.size / 1024)} KB`
    : `${Math.round(file.size / 1024)} KB · 已上传 OSS`;
  $("#garmentState").textContent = "预检中";
  $("#garmentState").className = "badge blue";

  const garment = await api("/v1/garments/analyze", {
    method: "POST",
    body: JSON.stringify({
      file: uploadedFile,
      expected_role: "garment",
      description: $("#preEditEnabled").value === "true" ? $("#intentInput").value : ""
    })
  });

  state.garment = garment;
  state.garment.reference_images = state.garmentReferenceImages;
  const hasBlock = garment.risk_flags.some(item => item.level === "block");
  $("#garmentState").textContent = hasBlock ? "不可提交" : "预检通过";
  $("#garmentState").className = hasBlock ? "badge red" : "badge green";
  renderGarmentAnalysis(garment);
  showGarmentCategoryConfirm(garment);
  updateSubmitState();
}

async function handleModelFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  let dataUrl;
  let uploadedFile;
  try {
    const uploaded = await uploadAssetToOss(file, "model");
    dataUrl = uploaded.dataUrl;
    uploadedFile = uploaded.uploadedFile;
  } catch (error) {
    $("#modelState").textContent = "上传失败";
    $("#modelState").className = "badge red";
    toast(`真人模特图上传失败：${error.message}`);
    return;
  }
  $("#modelUploadPreview").innerHTML = `<img src="${dataUrl}" alt="模特预览">`;
  $("#modelUploadName").textContent = file.name;
  $("#modelUploadMeta").textContent = uploadedFile.normalized_for_provider
    ? `${Math.round(file.size / 1024)} KB · 已自动生成模型合规图 ${Math.round(uploadedFile.size / 1024)} KB`
    : `${Math.round(file.size / 1024)} KB · 已上传 OSS`;
  $("#modelState").textContent = "验证中";
  $("#modelState").className = "badge blue";

  const model = await api("/v1/models/validate", {
    method: "POST",
    body: JSON.stringify({ file: { ...uploadedFile, expected_role: "model" } })
  });

  state.selectedModel = {
    ...model,
    name: model.name || "用户上传真人模特",
    categories: model.categories || ["dress", "coat", "pants", "shirt"],
    preview_url: dataUrl,
    file_url: uploadedFile.url || uploadedFile.data_url,
    preview_color: "#0f766e"
  };
  state.models = [state.selectedModel, ...state.models.filter(item => item.id !== state.selectedModel.id)];
  $("#modelState").textContent = uploadedFile.url ? "真人已上传" : "本地模特";
  $("#modelState").className = uploadedFile.url ? "badge green" : "badge amber";
  renderModels($("#modelGrid"), state.models, true);
  updateSubmitState();
  toast("已选择上传的真人模特图");
}

async function generateRecommendation() {
  if ($("#preEditEnabled").value !== "true") {
    toast("试衣前图改图已关闭，Agent 推荐参数暂不可编辑");
    return;
  }
  if (!state.garment || !state.selectedModel) {
    toast("请先上传服装并选择模特");
    return;
  }
  const data = await api("/v1/agent/recommendations", {
    method: "POST",
    body: JSON.stringify({
      garment_id: state.garment.id,
      model_id: state.selectedModel.id,
      intent: $("#intentInput").value,
      platform_use: $("#platformUse").value
    })
  });
  $("#outputType").value = data.output_type;
  $("#imageCount").value = data.image.count;
  $("#imageRatio").value = data.image.ratio;
  $("#imageBackground").value = data.image.background;
  $("#videoDuration").value = data.video.duration_seconds;
  $("#videoRatio").value = data.video.ratio;
  $("#motionTemplate").value = data.video.motion_template;
  $("#consistency").value = data.video.consistency;
  $("#recommendation").classList.remove("empty");
  $("#recommendation").innerHTML = `
    <strong>推荐输出：</strong>${data.output_type === "image_video" ? "图片+视频" : data.output_type === "video" ? "30秒视频" : "图片"}<br>
    <strong>姿态建议：</strong>${data.pose_suggestion}<br>
    <strong>图片参数：</strong>${data.image.count}张，${data.image.ratio}，${data.image.background}<br>
    <strong>视频参数：</strong>${data.video.duration_seconds}秒，${data.video.ratio}，${data.video.motion_template}<br>
    ${data.risks.length ? `<strong>风险提示：</strong>${data.risks.join(" ")}` : "<strong>风险提示：</strong>暂无明显风险"}
  `;
  if (!$("#postOptimizePrompt").value.trim()) {
    $("#postOptimizePrompt").value = [
      "商品一致性是铁律：颜色、版型比例、衣长、装饰细节和纹理必须与原服装图一致。",
      "如果美化和商品一致性冲突，必须牺牲美化，保留原服装商品特征。",
      "在不改变服装的前提下，要求图片高保真，尽全力提升清晰度，必须保留服装细节。",
      `用于${$("#platformUse").value}，背景${data.image.background}，画幅${data.image.ratio}。`,
      "保持服装款式、颜色、纹理、Logo、纽扣、版型和长度不变，不要重绘成另一件衣服。",
      data.risks.length ? `重点规避风险：${data.risks.join(" ")}` : "保持模特身份、脸部和身材比例自然，不要过度磨皮。"
    ].join("\n");
  }
  updateCostPreview();
  toast("Agent 推荐已生成");
}

function collectParams() {
  return {
    image: {
      count: Number($("#imageCount").value),
      ratio: $("#imageRatio").value,
      background: $("#imageBackground").value,
      keep_texture: true,
      quality_filter: $("#qualityFilter").value === "开启",
      platform_use: $("#platformUse").value,
      tryon_model: $("#tryonModel").value,
      garment_description: [
        "Target garment product. Hard rule: keep the original garment color identical.",
        "Hard rule: keep garment body proportions, width, silhouette and length exactly one-to-one.",
        "Hard rule: keep decorative details, logo, embroidery, buttons, fabric texture and pattern identical to the original product image.",
        "Do not redesign the garment. Do not change it into a similar fashion item."
      ].join(" ")
    },
    video: {
      duration_seconds: Number($("#videoDuration").value),
      ratio: $("#videoRatio").value,
      motion_template: $("#motionTemplate").value,
      camera: "中景全身",
      background: $("#imageBackground").value,
      audio: "无",
      consistency: $("#consistency").value
    },
    pre_edit: {
      enabled: $("#preEditEnabled").value === "true",
      model: $("#preEditModel").value,
      prompt: $("#preEditEnabled").value === "true" ? $("#intentInput").value : ""
    },
    refiner: {
      enabled: $("#refinerEnabled").value === "true"
    },
    post_optimize: {
      enabled: $("#postOptimizeEnabled").value === "true",
      model: $("#postOptimizeModel").value,
      prompt: $("#postOptimizePrompt").value,
      size: "1024x1536",
      quality: $("#qualityStrategy").value === "preview" ? "medium" : "high"
    },
    quality_strategy: $("#qualityStrategy").value,
    commercial_gate: {
      recommended_threshold: $("#qualityStrategy").value === "studio" ? 84 : 80,
      dimension_floor: 70,
      require_recommended_count: 1,
      hd_target_long_edge: 2048
    }
  };
}

function estimateCost() {
  const output = $("#outputType").value;
  const params = collectParams();
  const isGptImageTryon = params.image.tryon_model === "gpt-image:try-on" || params.image.tryon_model === "gpt-image:tryon" || params.image.tryon_model === "gpt-image";
  let cost = 0;
  if (output === "image" || output === "image_video") cost += params.image.count * (isGptImageTryon ? 14 : 8);
  if (output === "video" || output === "image_video") cost += params.video.duration_seconds * 6;
  if (params.quality_strategy === "studio") cost += params.image.count * 4;
  if (!isGptImageTryon && params.post_optimize.enabled && (output === "image" || output === "image_video")) cost += params.image.count * 6;
  return cost;
}

function updateCostPreview() {
  $("#costPreview").textContent = `预计 ${estimateCost()} 额度`;
}

function updateSubmitState() {
  const hasBlock = state.garment?.risk_flags?.some(item => item.level === "block");
  const preflight = buildPreflightChecks();
  const blocked = preflight.some(item => item.blocking && item.status !== "pass");
  $("#submitTaskBtn").disabled = !state.garment || !state.selectedModel || hasBlock || blocked;
  updateCostPreview();
  renderPreflightChecks(preflight);
}

function updatePreEditHint() {
  const enabled = $("#preEditEnabled").value === "true";
  updateAgentRecommendationLock();
  if (!enabled) {
    $("#preEditHint").textContent = "已关闭试衣前图改图，系统将直接使用原始模特图和服装图进入虚拟试衣。";
    return;
  }
  const model = $("#preEditModel").value;
  const hints = {
    "qwen-image-edit-plus": "当前选择：轻量保守编辑。适合清洁背景、轻微提亮、去水印、保留服装细节，成本相对可控。",
    "qwen-image-2.0-pro": "当前选择：高质量图改图。纹理、材质和语义遵循更强，适合电商详情图，但成本和耗时更高。",
    "qwen-image-edit-max": "当前选择：复杂一致性增强。适合人物一致性、复杂构图和细节要求高的场景，成本最高。"
  };
  $("#preEditHint").textContent = hints[model] || hints["qwen-image-edit-plus"];
}

function updateQualityStrategyHint() {
  const value = $("#qualityStrategy").value;
  const hints = {
    preview: "快速预览链路主要用于低成本看方向，不承诺商用高清输出。",
    commercial: "商用品质链路会生成至少 4 张候选图，并执行质量评分、精修和高清下载门槛。",
    studio: "商拍增强链路会用更严格推荐门槛，适合业务方验收、电商详情页和广告图。"
  };
  $("#qualityStrategyHint").textContent = hints[value] || hints.commercial;
}

function updateRefinerHint() {
  const enabled = $("#refinerEnabled").value === "true";
  $("#refinerHint").textContent = enabled
    ? "已开启试衣图精修。基础试衣生效后，会继续修复服装边缘、融合关系和清晰度。"
    : "已关闭试衣图精修。系统会跳过该环节，减少耗时和成本，但清晰度与融合自然度可能下降。";
}

function updatePostOptimizeHint() {
  const isGptImageTryon = $("#tryonModel").value === "gpt-image:try-on" || $("#tryonModel").value === "gpt-image:tryon" || $("#tryonModel").value === "gpt-image";
  if (isGptImageTryon) {
    $("#postOptimizeEnabled").value = "false";
    $("#postOptimizeEnabled").disabled = true;
    $("#postOptimizeHint").textContent = "GPT-Image 直接试衣模式已内置最终出图品质，无需二次优化。";
    return;
  }
  $("#postOptimizeEnabled").disabled = false;
  const enabled = $("#postOptimizeEnabled").value === "true";
  const model = $("#postOptimizeModel").value;
  $("#postOptimizeHint").textContent = enabled
    ? `试衣结果生成后会使用 ${model} 做最终商用出图，服装正面图和最多 ${MAX_GARMENT_REFERENCE_IMAGES} 张细节图会作为商品参考。`
    : "已关闭最终商用出图，结果将直接使用虚拟试衣/精修模型输出。";
}

function updateAgentRecommendationLock() {
  const preEditEnabled = $("#preEditEnabled").value === "true";
  $("#intentInput").disabled = !preEditEnabled;
  $("#recommendBtn").disabled = !preEditEnabled;
  $("#agentPanel").classList.toggle("disabled-panel", !preEditEnabled);
  $("#agentLockHint").textContent = preEditEnabled
    ? "Agent 推荐参数已解锁。这些参数只会传给试衣前图改图模型，不会传给虚拟试衣或最终商用出图模型。"
    : "当前不可编辑。只有开启“试衣前图改图”后，Agent 推荐参数才会解锁，并且这些参数只会传给试衣前图改图模型使用。";
  if (!preEditEnabled) {
    $("#recommendation").classList.add("empty");
    $("#recommendation").textContent = "试衣前图改图已默认关闭，Agent 推荐参数暂不可编辑，避免运营要求影响服装原图一致性。";
  } else if ($("#recommendation").textContent.includes("试衣前图改图已默认关闭")) {
    $("#recommendation").textContent = "等待 Agent 推荐";
  }
}

function buildPreflightChecks() {
  const cap = state.capabilities;
  const params = collectParams();
  const balance = Number($("#creditBalance").textContent || 0);
  const cost = estimateCost();
  const needsFullBody = Boolean(state.garment?.requires_full_body || GARMENT_CATEGORY_META[state.garment?.category_key]?.requiresFullBody);
  const modelIsHalfBody = state.selectedModel?.pose_type === "half_body";
  const checks = [
    {
      item: "服装图",
      status: state.garment ? state.garment.risk_flags?.some(flag => flag.level === "block") ? "block" : state.garment.risk_flags?.length ? "warn" : "pass" : "pending",
      blocking: true,
      message: state.garment ? state.garment.risk_flags?.map(flag => flag.message).join(" ") || "主体、格式和大小已通过基础检查。" : "请先上传服装平铺图。"
    },
    {
      item: "真人模特图",
      status: state.selectedModel?.file_url ? needsFullBody && modelIsHalfBody ? "block" : state.selectedModel.risk_flags?.length ? "warn" : "pass" : "block",
      blocking: true,
      message: state.selectedModel?.file_url
        ? needsFullBody && modelIsHalfBody
          ? `${state.garment?.category_label || "当前服装"}需要全身模特，当前选择的是半身照片，容易生成只穿上半身或缺少下摆，请更换全身模特照片。`
          : "真人模特图已就绪，建议使用正面全身清晰照片。"
        : "百炼真实试衣需要上传真人/模特图片，系统占位模特没有公网人物图。"
    },
    {
      item: "服装品类确认",
      status: state.garment ? state.garment.analysis?.category_source === "user_confirmed" ? "pass" : "warn" : "pending",
      blocking: false,
      message: state.garment ? `当前品类：${state.garment.category_label}。请在上传区确认，连衣裙、半身裙、裤装会要求全身模特。` : "上传服装后可确认品类。"
    },
    {
      item: "商用候选数量",
      status: params.image.count >= 4 || $("#outputType").value === "video" ? "pass" : "warn",
      blocking: false,
      message: `当前图片候选 ${params.image.count} 张。商用品质建议至少 4 张，以保证筛出 1 张推荐图。`
    },
    {
      item: "试衣模型",
      status: (() => {
        const model = $("#tryonModel").value;
        if (model === "gpt-image:try-on" || model === "gpt-image:tryon" || model === "gpt-image") {
          const entry = (cap?.tryon_models || []).find(m => m.value === "gpt-image:try-on");
          return entry?.enabled ? "pass" : "block";
        }
        if (model === "pixelcut:try-on") return cap?.pixelcut_tryon_enabled ? "pass" : "block";
        if (model === "302:fashn-tryon") return cap?.three_oh_two_fashn_tryon_enabled ? "pass" : "block";
        if (model === "replicate:idm-vton") return cap?.replicate_idm_vton_enabled ? "warn" : "block";
        if (model === "pixazo:fashn-vton") return cap?.pixazo_fashn_vton_enabled ? "warn" : "block";
        return "pass";
      })(),
      blocking: (() => {
        const model = $("#tryonModel").value;
        if (model === "gpt-image:try-on" || model === "gpt-image:tryon" || model === "gpt-image") {
          const entry = (cap?.tryon_models || []).find(m => m.value === "gpt-image:try-on");
          return !entry?.enabled;
        }
        if (model === "pixelcut:try-on" && !cap?.pixelcut_tryon_enabled) return true;
        if (model === "302:fashn-tryon" && !cap?.three_oh_two_fashn_tryon_enabled) return true;
        if (model === "replicate:idm-vton" && !cap?.replicate_idm_vton_enabled) return true;
        if (model === "pixazo:fashn-vton" && !cap?.pixazo_fashn_vton_enabled) return true;
        return false;
      })(),
      message: (() => {
        const model = $("#tryonModel").value;
        if (model === "gpt-image:try-on" || model === "gpt-image:tryon" || model === "gpt-image") {
          const entry = (cap?.tryon_models || []).find(m => m.value === "gpt-image:try-on");
          return entry?.enabled
            ? "当前选择 GPT-Image 1.5 直接试衣，跳过传统VTON模型，每张14额度。"
            : "当前选择 GPT-Image 1.5 直接试衣，但后端未启用（GPT_IMAGE_TRYON_ENABLED 或 OPENAI_API_KEY），无法提交。";
        }
        if (model === "pixelcut:try-on") {
          return cap?.pixelcut_tryon_enabled
            ? "当前选择 Pixelcut Try-On，作为新的主测通道。"
            : "当前选择 Pixelcut Try-On，但后端未配置 PIXELCUT_API_KEY，无法提交。";
        }
        if (model === "302:fashn-tryon") {
          return cap?.three_oh_two_fashn_tryon_enabled
            ? "当前选择 302.AI FASHN Try-On，作为新的主链路测试。"
            : "当前选择 302.AI FASHN Try-On，但后端未配置 302.AI Key，无法提交。";
        }
        if (model === "replicate:idm-vton") {
          return cap?.replicate_idm_vton_enabled
            ? "当前选择 IDM-VTON 实验模型。该模型页面标注 Non-Commercial use only，仅建议测试对比，不建议商用交付。"
            : "当前选择 IDM-VTON，但后端未配置 REPLICATE_API_TOKEN，无法提交。";
        }
        if (model === "pixazo:fashn-vton") {
          return cap?.pixazo_fashn_vton_enabled
            ? "当前选择 Pixazo Fashn VTON 中转备选。建议用于和百炼 Plus 做效果对比。"
            : "当前选择 Pixazo Fashn VTON，但后端未配置 PIXAZO_API_KEY，无法提交。";
        }
        return "当前选择百炼 AI 试衣 Plus。";
      })()
    },
    {
      item: "试衣图精修",
      status: ["pixelcut:try-on", "302:fashn-tryon", "replicate:idm-vton", "pixazo:fashn-vton"].includes($("#tryonModel").value) ? "warn" : $("#refinerEnabled").value !== "true" ? "warn" : cap?.refiner_enabled ? "pass" : "warn",
      blocking: false,
      message: ["pixelcut:try-on", "302:fashn-tryon", "replicate:idm-vton", "pixazo:fashn-vton"].includes($("#tryonModel").value)
        ? "当前试衣通道不走百炼试衣图精修，结果将直接进入商品一致性质检和最终商用出图。"
        : $("#refinerEnabled").value !== "true"
        ? "当前关闭试衣图精修，低清晰度和边缘融合风险会升高。"
        : cap?.refiner_enabled
          ? "已开启试衣图精修，推荐/可用结果可进入高清下载。"
          : "当前未读取到精修模型，低清晰度风险会升高。"
    },
    {
      item: "最终商用出图",
      status: $("#postOptimizeEnabled").value !== "true" ? "warn" : cap?.openai_image_optimizer_enabled ? "pass" : "warn",
      blocking: false,
      message: $("#postOptimizeEnabled").value !== "true"
        ? "当前关闭最终商用出图，商用清晰度和细节提升会弱一些。"
        : cap?.openai_image_optimizer_enabled
          ? "已开启最终商用出图，会使用“最终商用出图要求”做保守优化。"
          : "前端已开启，但后端未检测到出图能力，会自动跳过该环节。"
    },
    {
      item: "额度",
      status: balance >= cost ? "pass" : "block",
      blocking: true,
      message: `预计消耗 ${cost} 额度，当前可用 ${balance || 0}。`
    },
    {
      item: "API 支持",
      status: cap?.image_provider === "aliyun" && cap?.oss_configured ? "pass" : "warn",
      blocking: false,
      message: cap ? `当前供应商 ${cap.image_provider}，存储模式 ${cap.storage_mode}。` : "暂未读取到 API 能力边界。"
    }
  ];
  return checks;
}

function renderPreflightChecks(checks = buildPreflightChecks()) {
  const list = $("#preflightChecks");
  if (!list) return;
  const blocking = checks.filter(item => item.blocking && item.status !== "pass").length;
  const warnings = checks.filter(item => item.status === "warn").length;
  $("#preflightState").textContent = blocking ? "有阻断项" : warnings ? "有风险项" : "可提交";
  $("#preflightState").className = blocking ? "badge red" : warnings ? "badge amber" : "badge green";
  const icon = { pass: "通过", warn: "风险", block: "阻断", pending: "待补" };
  list.innerHTML = checks.map(item => `
    <div class="check-row ${item.status}">
      <span>${icon[item.status] || "待检"}</span>
      <div>
        <strong>${item.item}</strong>
        <small>${item.message}</small>
      </div>
    </div>
  `).join("");
}

async function submitTask() {
  if (!state.garment || !state.selectedModel) return;
  try {
    const task = await api("/v1/tryon/tasks", {
      method: "POST",
    body: JSON.stringify({
      garment_id: state.garment.id,
      model_id: state.selectedModel.id,
      output_type: $("#outputType").value,
      prompt: "",
      params: {
        ...collectParams(),
        garment_references: taskGarmentReferencePayload()
      }
    })
  });
    rememberCurrentTask(task.id);
    toast("任务已提交，开始生成");
    await loadCredits();
    startPolling(task.id);
  } catch (error) {
    renderSubmitError(error.payload?.detail, error.message);
    toast(error.payload?.detail?.userMessage || error.message);
  }
}

function renderSubmitError(detail, fallbackMessage) {
  $("#currentTask").innerHTML = `
    <div class="task-card">
      <h3>任务未提交</h3>
      <span class="badge red">输入不符合要求</span>
      <div class="failure-box">
        <strong>${detail?.userMessage || "提交失败"}</strong>
        <span>${detail?.suggestion || fallbackMessage || "请检查输入图片。"}</span>
        ${detail?.validation_errors?.length ? `<ul>${detail.validation_errors.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
      </div>
    </div>
  `;
  $("#resultGallery").innerHTML = "";
}

function renderCurrentTask(task) {
  $("#currentTask").innerHTML = renderTaskProgressCard(task);
  renderResults(task.results || []);
}

function publicTaskStage(task) {
  const stage = task?.current_stage || task?.status || "pending";
  const map = {
    pending: "素材检查中",
    prechecking: "素材检查中",
    pre_editing: "素材处理中",
    virtual_tryon: "虚拟试衣中",
    tryon_refining: "虚拟试衣中",
    effect_validating: "商品一致性检查中",
    quality_scoring: "商品一致性检查中",
    gpt_image_optimizing: "最终商用出图中",
    generating_keyframes: "视频生成中",
    rendering_video: "视频生成中",
    frame_checking: "视频检查中",
    encoding: "视频导出中",
    completed: "生成完成",
    failed: "生成失败",
    cancelled: "任务已取消"
  };
  if (task?.status === "completed") return "生成完成";
  if (task?.status === "failed") return "生成失败";
  return map[stage] || "处理中";
}

function renderTaskProgressCard(task) {
  const summary = task.quality_summary;
  return `
    <div class="task-card">
      <h3>${task.output_type === "image_video" ? "图片+视频任务" : task.output_type === "video" ? "视频任务" : "图片任务"}</h3>
      ${statusBadge(task.status)}
      <div class="progress"><span style="width:${task.progress || 0}%"></span></div>
      <p class="task-stage-message">${publicTaskStage(task)} · ${task.progress || 0}%</p>
      ${summary ? `<div class="quality-summary">
        <span>推荐 ${summary.recommended_count}</span>
        <span>可用 ${summary.usable_count}</span>
        <span>待修复 ${summary.repair_needed_count}</span>
        <span>最高分 ${summary.best_score}</span>
      </div>` : ""}
      ${task.status === "failed" ? renderFailureDetail(task) : ""}
      <p>任务编号：${task.id}</p>
    </div>
  `;
}

function renderFailureDetail(task) {
  const detail = task.failure_detail || {};
  const events = task.events || [];
  const lastEvent = events[events.length - 1];
  return `
    <div class="failure-box">
      <strong>失败原因：${detail.userMessage || task.failure_reason || "模型生成失败"}</strong>
      ${detail.code ? `<span>错误码：${detail.code}</span>` : ""}
      ${detail.suggestion ? `<span>处理建议：${detail.suggestion}</span>` : ""}
      ${task.failure_reason ? `<details><summary>查看供应商原始错误</summary><code>${escapeHtml(task.failure_reason)}</code></details>` : ""}
      ${lastEvent ? `<span>失败阶段：${publicTaskStage({ current_stage: lastEvent.status, status: task.status === "failed" ? "" : task.status })}，时间：${new Date(lastEvent.created_at).toLocaleString()}</span>` : ""}
    </div>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderResultsHtml(results) {
  return results.map(result => `
    <article class="result-card">
      ${result.media_type === "video"
        ? `<video src="${mediaUrl(result.video_url)}" poster="${mediaUrl(result.cover_url)}" controls muted playsinline></video>`
        : `<img src="${mediaUrl(result.image_url || result.cover_url)}" alt="生成结果">`
      }
      <div class="result-info">
        <strong>${result.media_type === "video" ? "试穿视频" : "试穿图片"} ${qualityBadge(result.quality_status)}</strong>
        ${result.model_meta?.provider === "mock" ? `<span class="badge amber">模拟结果，不是真实试衣</span>` : ""}
        ${result.model_meta?.openai_image_optimizer_rejected ? `<span class="badge amber">最终商用出图未通过，已回退到试衣精修图</span>` : result.model_meta?.openai_image_optimizer ? `<span class="badge green">已完成最终商用出图</span>` : ""}
        <span>商用综合分：${result.score} ${result.duration_seconds ? `· ${result.duration_seconds}秒` : ""}</span>
        ${result.quality_report ? `<span>自然度 ${result.quality_report.garment_naturalness} · 一致性 ${result.quality_report.garment_consistency} · 清晰度 ${result.quality_report.clarity}</span>` : ""}
        <span>高清状态：${result.hd_status || "待处理"} · ${result.download_allowed === false ? "不可下载" : "可下载"}</span>
        ${result.issue_tags?.length ? `<div class="issue-tags">${result.issue_tags.map(tag => `<span>${tag}</span>`).join("")}</div>` : ""}
        <div class="result-actions">
          <button class="secondary-btn" data-preview="${result.id}">查看效果</button>
          <button class="secondary-btn" data-open-result="${result.id}" ${result.download_allowed === false || ["repair_needed", "unusable"].includes(result.quality_status) ? "disabled" : ""}>下载/打开</button>
        </div>
      </div>
    </article>
  `).join("");
}

function renderResults(results) {
  $("#resultGallery").innerHTML = renderResultsHtml(results);
  bindResultActions(results, $("#resultGallery"));
}

function bindResultActions(results, root = document) {
  Array.from(root.querySelectorAll("[data-preview]")).forEach(button => {
    button.addEventListener("click", () => {
      const result = results.find(item => item.id === button.dataset.preview);
      if (result) openMediaModal(result);
    });
  });

  Array.from(root.querySelectorAll("[data-open-result]")).forEach(button => {
    button.addEventListener("click", async () => {
      try {
        const data = await api(`/v1/tryon/results/${button.dataset.openResult}/download`);
        window.open(mediaUrl(data.signed_url), "_blank", "noopener,noreferrer");
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

function mediaUrl(value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return value;
  return `${API_BASE}${value}`;
}

function openMediaModal(result) {
  const url = result.media_type === "video" ? mediaUrl(result.video_url) : mediaUrl(result.image_url || result.cover_url);
  $("#mediaModalContent").innerHTML = result.media_type === "video"
    ? `<video src="${url}" controls autoplay playsinline></video>`
    : `<img src="${url}" alt="试穿效果大图">`;
  $("#mediaModal").classList.add("open");
  $("#mediaModal").setAttribute("aria-hidden", "false");
}

function closeMediaModal() {
  $("#mediaModal").classList.remove("open");
  $("#mediaModal").setAttribute("aria-hidden", "true");
  $("#mediaModalContent").innerHTML = "";
}

function rememberCurrentTask(taskId) {
  state.currentTaskId = taskId;
  try {
    localStorage.setItem("vto.currentTaskId", taskId || "");
  } catch {
    // Local storage is only a convenience cache.
  }
}

function pickCurrentTask(tasks = []) {
  const cachedId = state.currentTaskId || (() => {
    try {
      return localStorage.getItem("vto.currentTaskId");
    } catch {
      return null;
    }
  })();
  const cached = cachedId ? tasks.find(task => task.id === cachedId) : null;
  if (cached && !isTerminalStatus(cached.status)) return cached;
  return tasks.find(task => !isTerminalStatus(task.status)) || null;
}

function restoreCurrentTask(tasks = []) {
  const task = pickCurrentTask(tasks);
  if (!task) {
    $("#currentTask").innerHTML = "暂无任务";
    $("#currentTask").className = "task-empty";
    renderResults([]);
    return;
  }
  rememberCurrentTask(task.id);
  $("#currentTask").className = "";
  renderCurrentTask(task);
  if (!isTerminalStatus(task.status)) startPolling(task.id);
}

function startPolling(taskId) {
  if (state.pollTimer) clearInterval(state.pollTimer);
  rememberCurrentTask(taskId);
  const tick = async () => {
    const task = await api(`/v1/tryon/tasks/${taskId}`);
    renderCurrentTask(task);
    if (isTerminalStatus(task.status)) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      await loadTasks();
      await loadCredits();
    }
  };
  tick();
  state.pollTimer = setInterval(tick, 1000);
}

async function loadTasks() {
  const tasks = await api("/v1/tryon/tasks");
  restoreCurrentTask(tasks);
  if (state.historyPollTimer) {
    clearTimeout(state.historyPollTimer);
    state.historyPollTimer = null;
  }

  $("#taskHistory").innerHTML = tasks.length ? tasks.map(task => `
    <article class="history-task ${state.expandedHistoryTaskId === task.id ? "open" : ""}">
      <div class="history-row">
        <div>
          <strong>${task.output_type} · ${task.id}</strong>
          <small>${publicTaskStage(task)} · ${new Date(task.created_at).toLocaleString()} · ${task.credit_cost}额度</small>
        </div>
        <div class="history-actions">
          ${statusBadge(task.status)}
          <button class="secondary-btn" data-view-task="${task.id}">${state.expandedHistoryTaskId === task.id ? "收起" : "查看进度"}</button>
        </div>
      </div>
      ${state.expandedHistoryTaskId === task.id ? `
        <div class="history-detail">
          ${renderTaskProgressCard(task)}
          <div class="result-gallery">${renderResultsHtml(task.results || [])}</div>
        </div>
      ` : ""}
    </article>
  `).join("") : `<div class="task-empty">暂无历史任务</div>`;

  Array.from($("#taskHistory").querySelectorAll("[data-view-task]")).forEach(button => {
    button.addEventListener("click", async () => {
      state.expandedHistoryTaskId = state.expandedHistoryTaskId === button.dataset.viewTask ? null : button.dataset.viewTask;
      await loadTasks();
    });
  });

  tasks.forEach(task => {
    const card = $(`.history-task.open`);
    if (card && task.id === state.expandedHistoryTaskId) {
      bindResultActions(task.results || [], card);
    }
  });

  const expandedTask = tasks.find(task => task.id === state.expandedHistoryTaskId);
  if (expandedTask && !isTerminalStatus(expandedTask.status)) {
    state.historyPollTimer = setTimeout(loadTasks, 2000);
  }
}

async function refreshTasksWithFeedback() {
  const button = $("#refreshTasksBtn");
  button.classList.add("loading");
  button.disabled = true;
  $("#taskHistory")?.classList.add("refreshing");
  try {
    await loadTasks();
    toast("任务历史已刷新");
  } catch (error) {
    toast(`刷新失败：${error.message}`);
  } finally {
    setTimeout(() => {
      button.classList.remove("loading");
      button.disabled = false;
      $("#taskHistory")?.classList.remove("refreshing");
    }, 280);
  }
}

async function loadManagedResults() {
  state.managedResults = await api("/v1/tryon/results");
  renderManagedResults();
}

function renderManagedResults() {
  const rows = state.resultFilter === "all"
    ? state.managedResults
    : state.managedResults.filter(item => item.quality_status === state.resultFilter);
  $("#resultManager").innerHTML = rows.length ? rows.map(result => `
    <article class="managed-result">
      <div class="managed-thumb">
        ${result.media_type === "video"
          ? `<video src="${mediaUrl(result.video_url)}" poster="${mediaUrl(result.cover_url)}" muted playsinline></video>`
          : `<img src="${mediaUrl(result.image_url || result.cover_url)}" alt="结果图">`}
      </div>
      <div>
        <strong>${qualityBadge(result.quality_status)} 商用综合分 ${result.score}</strong>
        <p>${result.task?.id || result.task_id} · ${new Date(result.created_at).toLocaleString()}</p>
        ${result.quality_report ? `<div class="metric-line">
          <span>自然度 ${result.quality_report.garment_naturalness}</span>
          <span>一致性 ${result.quality_report.garment_consistency}</span>
          <span>清晰度 ${result.quality_report.clarity}</span>
          <span>人体 ${result.quality_report.body_integrity}</span>
        </div>` : ""}
        ${result.issue_tags?.length ? `<div class="issue-tags">${result.issue_tags.map(tag => `<span>${tag}</span>`).join("")}</div>` : ""}
        ${result.model_meta?.openai_image_optimizer_rejected ? `<div class="issue-tags"><span>${result.model_meta.openai_image_optimizer_rejected_reason || "最终商用出图改变了目标服装，系统已自动回退。"}</span></div>` : ""}
      </div>
      <div class="managed-actions">
        <button class="secondary-btn" data-preview-managed="${result.id}">预览</button>
        <button class="secondary-btn" data-download-managed="${result.id}" ${result.download_allowed === false || ["repair_needed", "unusable"].includes(result.quality_status) ? "disabled" : ""}>高清下载</button>
      </div>
    </article>
  `).join("") : `<div class="task-empty">暂无该分组结果</div>`;

  $$("[data-preview-managed]").forEach(button => {
    button.addEventListener("click", () => {
      const result = state.managedResults.find(item => item.id === button.dataset.previewManaged);
      if (result) openMediaModal(result);
    });
  });
  $$("[data-download-managed]").forEach(button => {
    button.addEventListener("click", async () => {
      try {
        const data = await api(`/v1/tryon/results/${button.dataset.downloadManaged}/download`);
        window.open(mediaUrl(data.signed_url), "_blank", "noopener,noreferrer");
      } catch (error) {
        toast(error.message);
      }
    });
  });
}

async function loadCreditLogs() {
  const logs = await api("/v1/credits/logs");
  $("#creditLogs").innerHTML = logs.length ? logs.map(log => `
    <div class="list-row">
      <div>
        <strong>${log.amount} 额度 · ${log.reason}</strong>
        <small>${log.task_id} · ${log.status} · ${new Date(log.created_at).toLocaleString()}</small>
      </div>
      <span class="badge ${log.direction === "debit" ? "amber" : "green"}">${log.direction}</span>
    </div>
  `).join("") : `<div class="task-empty">暂无额度流水</div>`;
}

async function refreshTabData(tabName) {
  if (tabName !== "history" && state.historyPollTimer) {
    clearTimeout(state.historyPollTimer);
    state.historyPollTimer = null;
  }
  if (tabName === "create") {
    await Promise.allSettled([loadHealth(), loadCapabilities(), loadModels(), loadCredits(), loadTasks()]);
    updateSubmitState();
    return;
  }
  if (tabName === "history") {
    await loadTasks();
    return;
  }
  if (tabName === "results") {
    await loadManagedResults();
    return;
  }
  if (tabName === "models") {
    await loadModels();
    return;
  }
  if (tabName === "credits") {
    await Promise.allSettled([loadCapabilities(), loadCredits(), loadCreditLogs()]);
    renderModelStack();
  }
}

function bindTabs() {
  $$(".nav-item").forEach(button => {
    button.addEventListener("click", async () => {
      $$(".nav-item").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      $$(".tab-panel").forEach(panel => panel.classList.remove("active"));
      $(`#${button.dataset.tab}Tab`).classList.add("active");
      button.classList.add("loading-tab");
      try {
        await refreshTabData(button.dataset.tab);
      } catch (error) {
        toast(error.message);
      } finally {
        button.classList.remove("loading-tab");
      }
    });
  });
}

async function init() {
  bindTabs();
  $("#garmentInput").addEventListener("change", handleGarmentFile);
  $("#garmentDetailInput").addEventListener("change", handleGarmentDetailFiles);
  $("#garmentCategorySelect").addEventListener("change", confirmGarmentCategory);
  $("#modelInput").addEventListener("change", handleModelFile);
  $("#libraryModelInput").addEventListener("change", handleLibraryModelFile);
  $("#modelLibraryForm").addEventListener("submit", saveLibraryModel);
  $("#cancelLibraryModelBtn").addEventListener("click", resetModelLibraryForm);
  $("#recommendBtn").addEventListener("click", generateRecommendation);
  $("#submitTaskBtn").addEventListener("click", submitTask);
  $("#refreshTasksBtn").addEventListener("click", refreshTasksWithFeedback);
  $("#refreshResultsBtn").addEventListener("click", loadManagedResults);
  $$(".filter-chip").forEach(button => {
    button.addEventListener("click", async () => {
      $$(".filter-chip").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      state.resultFilter = button.dataset.resultFilter;
      await loadManagedResults();
      renderManagedResults();
    });
  });
  $$("[data-close-modal]").forEach(button => button.addEventListener("click", closeMediaModal));
  ["outputType", "imageCount", "imageRatio", "imageBackground", "videoDuration", "videoRatio", "motionTemplate", "consistency", "qualityFilter", "platformUse", "tryonModel"].forEach(id => {
    $(`#${id}`).addEventListener("change", updateSubmitState);
  });
  ["preEditEnabled", "preEditModel"].forEach(id => {
    $(`#${id}`).addEventListener("change", () => {
      updatePreEditHint();
      updateSubmitState();
    });
  });
  $("#refinerEnabled").addEventListener("change", () => {
    updateRefinerHint();
    updateSubmitState();
  });
  $("#qualityStrategy").addEventListener("change", () => {
    updateQualityStrategyHint();
    updatePostOptimizeHint();
    updateSubmitState();
  });
  ["postOptimizeEnabled", "postOptimizeModel"].forEach(id => {
    $(`#${id}`).addEventListener("change", () => {
      updatePostOptimizeHint();
      updateSubmitState();
    });
  });
  $("#tryonModel").addEventListener("change", () => {
    updatePostOptimizeHint();
    updateSubmitState();
  });
  $("#postOptimizePrompt").addEventListener("input", updateSubmitState);

  await loadHealth();
  await loadCapabilities();
  await loadModels();
  await loadCredits();
  await loadTasks();
  renderGarmentReferenceImages();
  updateSubmitState();
  updatePreEditHint();
  updateRefinerHint();
  updateQualityStrategyHint();
  updatePostOptimizeHint();
}

init().catch(error => {
  setApiStatus(false);
  toast(error.message);
});
