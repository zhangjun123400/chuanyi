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
  selectedResultIds: new Set(),
  resultFilter: "all",
  currentTaskId: null,
  pollTimer: null,
  expandedHistoryTaskId: null,
  selectedProgressTaskId: null,
  historyPollTimer: null,
  libraryModelPreviewDataUrl: null
};

// ── v2.0 Auth state ──
const auth = {
  accessToken: null,
  refreshToken: null,
  user: null
};

// ── v2.0 Token helpers ──
function saveTokens(accessToken, refreshToken, rememberMe) {
  auth.accessToken = accessToken;
  auth.refreshToken = refreshToken;
  if (rememberMe) {
    localStorage.setItem("vto.refreshToken", refreshToken);
  } else {
    sessionStorage.setItem("vto.refreshToken", refreshToken);
  }
}

function loadStoredToken() {
  return localStorage.getItem("vto.refreshToken") || sessionStorage.getItem("vto.refreshToken");
}

function clearTokens() {
  auth.accessToken = null;
  auth.refreshToken = null;
  auth.user = null;
  localStorage.removeItem("vto.refreshToken");
  sessionStorage.removeItem("vto.refreshToken");
}

// ── v2.0 Leader-follower token refresh ──
let refreshPromise = null;

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: auth.refreshToken })
      });
      if (!res.ok) throw new Error("refresh failed");
      const data = await res.json();
      const { access_token, refresh_token } = data.data;
      auth.accessToken = access_token;
      auth.refreshToken = refresh_token;
      if (localStorage.getItem("vto.refreshToken")) {
        localStorage.setItem("vto.refreshToken", refresh_token);
      } else {
        sessionStorage.setItem("vto.refreshToken", refresh_token);
      }
      return access_token;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// ── v2.0 Auth UI helpers ──
function showLogin() {
  const appShell = document.getElementById("appShell");
  const loginOverlay = document.getElementById("loginOverlay");
  if (appShell) appShell.style.display = "none";
  if (loginOverlay) loginOverlay.style.display = "";
  const errEl = document.getElementById("loginError");
  if (errEl) errEl.classList.add("hidden");
}

function showApp() {
  const loginOverlay = document.getElementById("loginOverlay");
  const appShell = document.getElementById("appShell");
  if (loginOverlay) loginOverlay.style.display = "none";
  if (appShell) appShell.style.display = "";
  const sidebarUser = document.getElementById("sidebarUser");
  if (sidebarUser) sidebarUser.classList.remove("hidden");
  // Hide legacy credit card when user area is visible
  const sideCard = document.querySelector(".side-card");
  if (sideCard) sideCard.style.display = "none";
  if (auth.user) {
    const nameEl = document.getElementById("sidebarUserName");
    const roleEl = document.getElementById("sidebarUserRole");
    const balEl = document.getElementById("sidebarUserBalance");
    if (nameEl) nameEl.textContent = auth.user.name;
    if (roleEl) roleEl.textContent = auth.user.role === "admin" ? "管理员" : "运营";
    if (balEl) balEl.textContent = auth.user.credit_balance;

    // Calculate and display login expiry
    const expiryEl = document.getElementById("sidebarLoginExpiry");
    if (expiryEl) {
      const remembered = !!localStorage.getItem("vto.refreshToken");
      const days = remembered ? 30 : 7;
      const expiryDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const month = expiryDate.getMonth() + 1;
      const day = expiryDate.getDate();
      expiryEl.innerHTML = `&#9679; 登录有效期至 ${month}月${day}日`;
    }
  }
}

// ── v2.0 Auth actions ──
async function login(email, password, rememberMe) {
  const res = await fetch(`${API_BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, remember_me: rememberMe })
  });
  const payload = await res.json();
  if (!res.ok) {
    const err = new Error(payload.message || payload.error || "登录失败");
    err.payload = payload;
    throw err;
  }
  const { access_token, refresh_token, user } = payload.data;
  auth.accessToken = access_token;
  auth.refreshToken = refresh_token;
  auth.user = user;
  saveTokens(access_token, refresh_token, rememberMe);
  return user;
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById("loginSubmitBtn");
  const errorEl = document.getElementById("loginError");
  btn.disabled = true;
  btn.classList.add("loading");
  errorEl.classList.add("hidden");
  try {
    await login(
      document.getElementById("loginEmail").value.trim(),
      document.getElementById("loginPassword").value,
      document.getElementById("loginRemember").checked
    );
    showApp();
    await initApp();
  } catch (err) {
    let msg = err.message;
    if (err.payload && err.payload.remaining_attempts != null) {
      const remaining = err.payload.remaining_attempts;
      if (remaining > 0) {
        msg = `${msg}，剩余 ${remaining} 次尝试`;
      } else {
        msg = `${msg}，账号已临时锁定，请15分钟后重试`;
      }
    }
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

async function handleLogout() {
  try {
    if (auth.refreshToken) {
      await api("/v1/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: auth.refreshToken })
      }).catch(() => {});
    }
  } finally {
    clearTokens();
    showLogin();
  }
}

function openChangePasswordModal() {
  const modal = document.getElementById("changePasswordModal");
  if (modal) { modal.classList.add("open"); modal.setAttribute("aria-hidden", "false"); }
  document.getElementById("changePasswordForm").reset();
  document.getElementById("changePasswordError").classList.add("hidden");
}

function closeChangePasswordModal() {
  const modal = document.getElementById("changePasswordModal");
  if (modal) { modal.classList.remove("open"); modal.setAttribute("aria-hidden", "true"); }
}

let pwdChangedTimer = null;

function showPasswordChanged() {
  const overlay = document.getElementById("passwordChangedOverlay");
  if (overlay) overlay.classList.remove("hidden");

  let remaining = 3;
  const countdownEl = document.getElementById("passwordChangedCountdown");
  if (countdownEl) countdownEl.textContent = `${remaining} 秒后自动跳转登录页...`;

  if (pwdChangedTimer) clearInterval(pwdChangedTimer);
  pwdChangedTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(pwdChangedTimer);
      pwdChangedTimer = null;
      overlay.classList.add("hidden");
      clearTokens();
      showLogin();
    } else {
      if (countdownEl) countdownEl.textContent = `${remaining} 秒后自动跳转登录页...`;
    }
  }, 1000);
}

function hidePasswordChanged() {
  if (pwdChangedTimer) { clearInterval(pwdChangedTimer); pwdChangedTimer = null; }
  const overlay = document.getElementById("passwordChangedOverlay");
  if (overlay) overlay.classList.add("hidden");
  clearTokens();
  showLogin();
}

async function handleChangePassword(e) {
  e.preventDefault();
  const btn = document.getElementById("changePasswordSubmitBtn");
  const errorEl = document.getElementById("changePasswordError");
  const oldPwd = document.getElementById("oldPassword").value;
  const newPwd = document.getElementById("newPassword").value;
  const confirmPwd = document.getElementById("confirmPassword").value;

  if (newPwd !== confirmPwd) {
    errorEl.textContent = "两次输入的新密码不一致";
    errorEl.classList.remove("hidden");
    return;
  }
  if (newPwd.length < 6) {
    errorEl.textContent = "新密码至少6个字符";
    errorEl.classList.remove("hidden");
    return;
  }

  btn.disabled = true;
  btn.classList.add("loading");
  errorEl.classList.add("hidden");
  try {
    await api("/v1/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
    });
    closeChangePasswordModal();
    showPasswordChanged();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (auth.accessToken) {
    headers["Authorization"] = `Bearer ${auth.accessToken}`;
  }

  let res = await fetch(`${API_BASE}${path}`, { headers, ...options });

  // v2.0: Handle 401 with token refresh (leader-follower pattern)
  if (res.status === 401 && auth.refreshToken) {
    try {
      const newToken = await refreshAccessToken();
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE}${path}`, { headers, ...options });
    } catch {
      clearTokens();
      showLogin();
      throw new Error("登录已过期，请重新登录");
    }
  }

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
    recommended: ["推荐", "badge-success"],
    usable: ["可用", "badge-info"],
    repair_needed: ["待修复", "badge-warning"],
    unusable: ["不可用", "badge-danger"],
    failed: ["失败", "badge-danger"]
  };
  const item = map[status] || ["处理中", "badge-muted"];
  return `<span class="badge ${item[1]}">${item[0]}</span>`;
}

function statusBadge(status) {
  if (status === "completed") return '<span class="badge badge-success">已完成</span>';
  if (status === "failed") return '<span class="badge badge-danger">失败</span>';
  if (status === "partial_failed") return '<span class="badge badge-warning">部分失败</span>';
  if (status === "cancelled") return '<span class="badge badge-muted">已取消</span>';
  return '<span class="badge badge-info">处理中</span>';
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
  // API capability card hidden per user request
  const el = $("#apiCapability");
  if (el) el.style.display = "none";
  renderModelStack();
}

function renderModelStack() {
  const el = $("#modelStack");
  if (!el) return;
  const stack = state.capabilities?.model_stack || [];
  if (!stack.length) {
    el.innerHTML = `<div class="task-empty">暂未读取到模型配置</div>`;
    return;
  }
  // Group by category
  const groups = { tryon: [], pre_edit: [], post_optimize: [], preflight: [] };
  stack.forEach(item => {
    if (item.category === "tryon") groups.tryon.push(item);
    else if (item.category === "pre_edit") groups.pre_edit.push(item);
    else if (item.category === "post_optimize") groups.post_optimize.push(item);
    else groups.preflight.push(item);
  });
  const categoryDefs = [
    { key: "tryon", label: "试衣模型", color: "var(--brand)", bg: "var(--brand-light)", sectionLabel: "试衣模型", sectionTitle: "Virtual Try-On Models", sectionDesc: "核心试衣生成能力，将服装图与模特图合成试穿效果" },
    { key: "pre_edit", label: "图改图模型", color: "var(--info)", bg: "#EEF2FF", sectionLabel: "图改图模型", sectionTitle: "Pre-Edit Models · 试衣前图像预处理", sectionDesc: "在试衣前对服装图进行背景清洁、去水印、调色等预处理" },
    { key: "post_optimize", label: "出图模型", color: "var(--success)", bg: "var(--success-light)", sectionLabel: "出图模型", sectionTitle: "Post-Optimize Models · 最终商用出图", sectionDesc: "试衣完成后进行高清放大、细节增强、自然度优化" },
    { key: "preflight", label: "预检与辅助", color: "var(--warning)", bg: "var(--warning-light)", sectionLabel: "预检与辅助", sectionTitle: "Preflight & Auxiliary Services", sectionDesc: "上传预检、品类识别、质量评分等辅助 AI 服务" }
  ];
  const activeCount = stack.filter(s => s.status === "启用").length;
  const navHtml = categoryDefs.filter(d => groups[d.key].length).map((d, i) => `
    <button class="nav-item ${i === 0 ? "active" : ""}" data-stack-cat="${d.key}">
      <span class="nav-dot" style="background:${d.color};"></span> ${d.label}
      <span class="nav-count">${groups[d.key].length}</span>
    </button>
  `).join("") + `
    <div class="model-stack-summary">
      <div class="flex justify-between items-center">
        <span class="text-xs text-muted">已启用</span>
        <span class="text-sm font-bold" style="color:var(--brand);">${activeCount} / ${stack.length}</span>
      </div>
      <div class="progress-bar mt-sm" style="height:4px;"><div class="progress-fill" style="width:${Math.round(activeCount / stack.length * 100)}%;"></div></div>
    </div>`;
  const contentHtml = categoryDefs.filter(d => groups[d.key].length).map((d, i) => `
    <div class="model-stack-category ${i === 0 ? "" : "hidden"}" data-stack-cat-content="${d.key}">
      <div class="section-header">
        <span class="section-label" style="background:${d.bg};color:${d.color};">${d.sectionLabel}</span>
        <div><h3>${d.sectionTitle}</h3><span class="text-xs text-muted">${d.sectionDesc}</span></div>
      </div>
      ${groups[d.key].map(item => {
        const icon = item.name.includes("GPT-Image") || item.name.includes("gpt-image") ? "🤖"
          : item.name.includes("百炼") || item.name.includes("aliyun") ? "☁️"
          : item.name.includes("302") || item.name.includes("FASHN") ? "🔄"
          : item.name.includes("Pixazo") || item.name.includes("pixazo") ? "🖼️"
          : item.name.includes("Replicate") || item.name.includes("IDM") ? "🧪"
          : "🔗";
        return `
        <div class="model-row-card">
          <div class="flex items-center gap-md">
            <div class="model-row-card-icon" style="background:${item.status === '启用' ? 'var(--brand-light)' : 'var(--gray-100)'};">${icon}</div>
            <div class="model-row-card-info">
              <strong>${item.name}${item.status === "启用" && item.is_default ? ' <span class="badge badge-success">当前主测</span>' : item.status === "启用" ? ' <span class="badge badge-info">启用</span>' : ' <span class="badge badge-muted">未启用</span>'}</strong>
              <p class="text-xs text-muted">${item.purpose}</p>
            </div>
          </div>
          <div class="flex items-center gap-lg">
            <span class="text-xs text-muted">${item.model}</span>
            <div class="toggle ${item.status === '启用' ? 'on' : ''}"></div>
          </div>
        </div>
      `;
      }).join("")}
    </div>
  `).join("");
  el.innerHTML = `<div class="model-stack-nav" id="modelStackNav">${navHtml}</div><div class="model-stack-content" id="modelStackContent">${contentHtml}</div>`;
  // Sub-nav click handlers
  const navContainer = el.querySelector("#modelStackNav");
  if (navContainer) {
    navContainer.querySelectorAll("[data-stack-cat]").forEach(btn => {
      btn.addEventListener("click", () => {
        navContainer.querySelectorAll("[data-stack-cat]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const cat = btn.dataset.stackCat;
        el.querySelectorAll("[data-stack-cat-content]").forEach(div => div.classList.add("hidden"));
        const content = el.querySelector(`[data-stack-cat-content="${cat}"]`);
        if (content) content.classList.remove("hidden");
      });
    });
  }
}

async function loadCredits() {
  const data = await api("/v1/credits/balance");
  $("#creditBalance").textContent = data.balance;
  const balEl = document.getElementById("sidebarUserBalance");
  if (balEl) balEl.textContent = data.balance;
}

function renderModels(target, models, selectable) {
  const gradients = [
    "linear-gradient(135deg, #f0e6ff, #e0d0f8)",
    "linear-gradient(135deg, #e6f0ff, #d0ddf8)",
    "linear-gradient(135deg, #ffe6f0, #f8d0e0)",
    "linear-gradient(135deg, #e6fff0, #d0f8e0)",
    "linear-gradient(135deg, #fff3e6, #f8e8d0)",
    "linear-gradient(135deg, #e6f4ff, #d0e4f8)",
    "linear-gradient(135deg, #f5e6ff, #e8d0f8)",
    "linear-gradient(135deg, #ffe6e6, #f8d0d0)"
  ];
  target.innerHTML = models.map((model, idx) => {
    const selected = state.selectedModel?.id === model.id;
    return `
    <div class="model-card ${selected ? "selected" : ""}" data-model-id="${model.id}" style="aspect-ratio:3/4;border-radius:var(--radius-sm);background:${gradients[idx % gradients.length]};${selected ? "" : "border:2px dashed var(--gray-200);"}display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--gray-600);cursor:pointer;position:relative;transition:all var(--fast) var(--ease);">
      ${model.preview_url ? `<img src="${mediaUrl(model.preview_url)}" alt="${model.name}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:var(--radius-sm);">` : ""}
      ${selected ? '<span style="position:absolute;top:4px;right:4px;width:18px;height:18px;border-radius:50%;background:var(--brand);color:#fff;font-size:10px;display:flex;align-items:center;justify-content:center;font-weight:700;z-index:2;">✓</span>' : ""}
    </div>
  `}).join("");

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
        $("#modelState").className = "badge badge-success";
        renderModels($("#modelGrid"), state.models, true);
        updateSubmitState();
        toast(`已选择 ${model.name}`);
      });
    });
  }
}

async function renderProgressTab() {
  const tasks = await api("/v1/tryon/tasks");
  const activeTasks = tasks.filter(t => !isTerminalStatus(t.status));
  const todayStart = new Date(new Date().setHours(0,0,0,0)).toISOString();
  const todayDone = tasks.filter(t => isTerminalStatus(t.status) && t.created_at >= todayStart);
  const doneTasks = tasks.filter(t => t.status === "completed" || t.status === "partial_failed");
  const avgTime = doneTasks.length ? Math.round(doneTasks.reduce((sum, t) => {
    const dur = t.updated_at ? (new Date(t.updated_at) - new Date(t.created_at)) / 1000 : 0;
    return sum + dur;
  }, 0) / doneTasks.length) : 0;

  setStatVal("statProgressActive", activeTasks.length);
  setStatVal("statProgressToday", todayDone.length);
  setStatVal("statProgressRate", activeTasks.length + doneTasks.length ? Math.round(doneTasks.length / (activeTasks.length + doneTasks.length) * 1000) / 10 + "%" : "100%");
  setStatVal("statProgressAvg", avgTime ? `${avgTime}s` : "--");

  const progMain = $("#progressMain");
  const progSidebar = $("#progressSidebar");
  if (!progMain || !progSidebar) return;

  if (!activeTasks.length) {
    progMain.innerHTML = `<div class="empty-state"><div class="empty-icon">⏳</div><strong>暂无进行中任务</strong><p>提交生成任务后将在此处显示实时进度</p></div>`;
    progSidebar.innerHTML = "";
    return;
  }

  // Auto-select first task if none selected or if selected task no longer active
  const selectedId = state.selectedProgressTaskId;
  const selectedTask = activeTasks.find(t => t.id === selectedId);
  if (!selectedTask) {
    state.selectedProgressTaskId = activeTasks[0].id;
  }
  const task = activeTasks.find(t => t.id === state.selectedProgressTaskId) || activeTasks[0];

  // Render task list sidebar
  progSidebar.innerHTML = `
    <div class="card" style="position:sticky;top:var(--space-xl);">
      <div class="card-header"><div><h2>进行中任务</h2><p>共 ${activeTasks.length} 个 · 点击切换</p></div></div>
      <div style="display:flex;flex-direction:column;gap:var(--space-sm);">
        ${activeTasks.map(t => {
          const p = t.progress || 0;
          const isSelected = t.id === task.id;
          const stage = publicTaskStage(t);
          return `
          <div class="progress-task-card ${isSelected ? "selected" : ""}" data-select-progress="${t.id}" style="
            padding:var(--space-md); border-radius:var(--radius-md); cursor:pointer;
            transition:all var(--fast) var(--ease);
            ${isSelected ? 'background:var(--brand-light);border:1px solid var(--brand);' : 'background:var(--surface);border:1px solid var(--gray-100);'}
          ">
            <div class="flex justify-between items-center" style="margin-bottom:6px;">
              <strong style="font-size:13px;">${t.id}</strong>
              ${statusBadge(t.status)}
            </div>
            <div class="text-xs text-muted" style="margin-bottom:4px;">${stage}</div>
            <div class="progress-bar" style="height:4px;border-radius:2px;"><div class="progress-fill" style="width:${p}%;${t.status === 'failed' ? 'background:var(--danger);' : ''}"></div></div>
            <div class="text-xs text-muted" style="margin-top:4px;text-align:right;">${p}%</div>
          </div>`;
        }).join("")}
      </div>
    </div>
  `;

  // Render selected task detail in main area
  renderProgressTaskDetail(progMain, task);

  // Bind click handlers for task selection
  $$("[data-select-progress]").forEach(card => {
    card.addEventListener("click", async () => {
      state.selectedProgressTaskId = card.dataset.selectProgress;
      await renderProgressTab();
    });
  });
}

function renderProgressTaskDetail(container, task) {
  const pct = task.progress || 0;
  const circ = 2 * Math.PI * 30;
  const offset = circ - (pct / 100) * circ;
  const stageLabel = publicTaskStage(task);
  const isGptImage = task.params?.image?.tryon_model === "gpt-image:try-on" || task.params?.image?.tryon_model === "gpt-image:tryon";

  const stageMap = [
    { key: "prechecking", label: "上传预检" },
    { key: "pre_editing", label: "图像预处理", skippable: isGptImage },
    { key: "virtual_tryon", label: "试衣生成中" },
    { key: "quality_scoring", label: "质量评分" },
    { key: "tryon_refining", label: "精修复", skippable: isGptImage },
    { key: "quality_gating", label: "质检分≥75" },
    { key: "gpt_image_optimizing", label: "高清出图" }
  ];
  const videoStages = [
    { key: "generating_keyframes", label: "关键帧生成" },
    { key: "rendering_video", label: "视频渲染" },
    { key: "encoding", label: "视频导出" }
  ];
  const allStages = task.output_type === "video" || task.output_type === "image_video"
    ? [...stageMap, ...videoStages] : stageMap;

  const currentStage = task.current_stage || "";
  const currentStageIdx = task.status === "failed"
    ? allStages.findIndex(s => s.key === currentStage)
    : allStages.findIndex(s => s.key === currentStage);

  const pipelineHtml = allStages.map((s, i) => {
    let cls = "pipeline-step";
    if (task.status === "failed" && i === currentStageIdx && currentStageIdx >= 0) {
      cls = "pipeline-step fail";
    } else if (task.status === "failed" && i > currentStageIdx) {
      cls = "pipeline-step";
    } else if (i < currentStageIdx) {
      cls = "pipeline-step done";
    } else if (i === currentStageIdx && task.status !== "completed") {
      cls = "pipeline-step active";
    }
    const afterFail = task.status === "failed" && i >= currentStageIdx && currentStageIdx >= 0;
    const stepStyle = afterFail && i > currentStageIdx ? "opacity:.4;" : "";
    const arrowStyle = afterFail && i < allStages.length - 1 ? ' style="color:var(--gray-200);"' : "";
    const label = (cls.includes("done") ? "✓ " : cls.includes("fail") ? "✕ " : cls.includes("active") ? "⟳ " : "") + s.label;
    return `<span class="${cls}"${stepStyle ? ` style="${stepStyle}"` : ""}>${label}</span>${i < allStages.length - 1 ? `<span class="pipeline-arrow"${arrowStyle}>→</span>` : ""}`;
  }).join("");

  const events = task.events || [];
  const timelineHtml = events.length ? events.map((evt, i) => {
    let cls = "done";
    if (i === events.length - 1 && task.status === "failed") cls = "fail";
    else if (i === events.length - 1 && !isTerminalStatus(task.status)) cls = "active";
    return `<div class="timeline-item ${cls}"><strong>${publicTaskStage({ current_stage: evt.status, status: "processing" })}</strong><span>${new Date(evt.created_at).toLocaleTimeString("zh-CN")}${evt.message ? " · " + evt.message : ""}</span></div>`;
  }).join("") : `<div class="timeline-item active"><strong>任务已提交</strong><span>${new Date(task.created_at).toLocaleTimeString("zh-CN")}</span></div>`;

  const desc = task.output_type === "video" ? "视频任务" : task.output_type === "image_video" ? "图+视频" : "图片";
  const modelLabel = task.params?.image?.tryon_model || "";

  container.innerHTML = `
    <div class="card">
      <div class="flex justify-between items-center">
        <div><h2 style="font-size:18px;font-weight:600;">任务 ${task.id}</h2><p class="text-sm text-muted">${desc}${modelLabel ? " · " + modelLabel : ""}</p></div>
        <div style="text-align:right;">
          ${statusBadge(task.status)}
          <p class="text-xs text-muted mt-sm">${task.status === "failed" ? "任务失败" : pct < 100 ? "预计剩余 " + Math.max(1, Math.round((100 - pct) * 1.5)) + " 秒" : "即将完成"}</p>
        </div>
      </div>
      <div class="progress-bar mt-md" style="height:8px;border-radius:4px;"><div class="progress-fill" style="width:${pct}%;${task.status === 'failed' ? 'background:var(--danger);' : ''}"></div></div>
      ${task.status === "failed" ? `<div class="alert alert-danger mt-md">${task.failure_reason || "模型生成失败，请重试或更换素材。"}</div>` : ""}
    </div>

    <div class="card"${task.status === "failed" ? ' style="border:1px solid #FECACA;"' : ""}>
      <div class="card-header"><div><h2>品质管线 Quality Pipeline</h2><p>实时展示各步骤进展${task.status === "failed" ? " · 检测到失败步骤" : ""}</p></div>${task.status === "failed" ? '<span class="badge badge-danger">任务失败</span>' : ""}</div>
      <div class="pipeline" style="flex-wrap:wrap;">${pipelineHtml}</div>
      ${task.status === "failed" ? `<div class="flex gap-sm mt-md"><button class="btn btn-primary btn-sm" data-retry-task="${task.id}">重新提交</button><button class="btn btn-secondary btn-sm" data-retry-params="${task.id}">更换服装图</button></div>` : ""}
    </div>

    <div class="card">
      <div class="card-header"><div><h2>执行时间线</h2><p>实时更新各步骤状态与耗时</p></div></div>
      <div class="timeline">${timelineHtml}</div>
    </div>

    <div class="card">
      <div class="card-header"><div><h2>任务信息</h2></div></div>
      <div style="display:flex;flex-direction:column;gap:var(--space-md);">
        <div style="display:flex;align-items:center;gap:var(--space-lg);padding:var(--space-md);background:var(--gray-50);border-radius:var(--radius-md);">
          <svg width="72" height="72" viewBox="0 0 72 72" style="flex-shrink:0;">
            <circle cx="36" cy="36" r="30" fill="none" stroke="var(--gray-200)" stroke-width="6"/>
            <circle cx="36" cy="36" r="30" fill="none" stroke="${task.status === 'failed' ? 'var(--danger)' : 'var(--brand)'}" stroke-width="6"
              stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" stroke-linecap="round"
              transform="rotate(-90 36 36)" style="transition: stroke-dashoffset 0.6s var(--ease);"/>
            <text x="36" y="38" text-anchor="middle" font-size="18" font-weight="700" fill="var(--gray-900)">${pct}%</text>
          </svg>
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--gray-800);">${stageLabel}</div>
            <div class="text-xs text-muted">步骤 ${Math.min(currentStageIdx + 1, allStages.length)} / ${allStages.length}</div>
            <div class="text-xs text-muted">${pct < 100 && task.status !== "failed" ? "预计剩余 " + Math.max(1, Math.round((100 - pct) * 1.5)) + " 秒" : task.status === "failed" ? "已中断" : "完成"}</div>
          </div>
        </div>
        <div><span class="text-xs text-muted">任务 ID</span><br><span class="text-sm font-bold">${task.id}</span></div>
        <div><span class="text-xs text-muted">提交时间</span><br><span class="text-sm">${new Date(task.created_at).toLocaleString()}</span></div>
        <div><span class="text-xs text-muted">已用额度</span><br><span class="text-sm font-bold" style="color:var(--brand);">${task.credit_cost ?? "--"} (${isTerminalStatus(task.status) ? "已结算" : "预扣"})</span></div>
        <div><span class="text-xs text-muted">试衣模型</span><br><span class="text-sm">${modelLabel || "--"}</span></div>
        <div><span class="text-xs text-muted">品质链路</span><br>${task.params?.quality_strategy ? `<span class="badge badge-info">${task.params.quality_strategy === "commercial" ? "商用品质" : task.params.quality_strategy === "studio" ? "商拍增强" : "快速预览"}</span>` : '<span class="badge badge-muted">--</span>'}</div>
        <hr style="border:none;border-top:1px solid var(--gray-100);">
        ${!isTerminalStatus(task.status) ? `<button class="btn btn-secondary" style="width:100%;" data-cancel-progress="${task.id}">取消任务</button><span class="text-xs text-muted" style="text-align:center;">取消后按进度比例返还额度</span>` : ""}
        ${task.status === "failed" ? `<button class="btn btn-primary" style="width:100%;" data-retry-task="${task.id}">重试任务</button>` : ""}
      </div>
    </div>
  `;
}

function renderModelLibrary() {
  renderModelLibraryFiltered();
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
    throw new Error("后端未返回图片地址");
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

// ---- Stats ----
async function loadStats() {
  try {
    const stats = await api("/v1/stats");
    renderStats(stats);
  } catch (err) {
    console.error("loadStats failed:", err.message || err);
  }
}

function setStatVal(id, val) { const el = $(`#${id}`); if (el) el.textContent = val; }

function renderStats(stats) {
  setStatVal("statMonthlyTasks", stats.monthly_tasks ?? "--");
  setStatVal("statSuccessRate", stats.success_rate != null ? `${stats.success_rate}%` : "--");
  setStatVal("statAvailableCredits", stats.available_credits ?? "--");
  setStatVal("statActiveTasks", stats.active_tasks ?? "--");
  setStatVal("statMonthlyChange", stats.monthly_tasks ? "本月累计" : "");
  setStatVal("statRateChange", stats.success_rate >= 90 ? `↑ 稳定` : "");
  const creditsUsedEl = $("#statCreditsUsed");
  if (creditsUsedEl) {
    creditsUsedEl.textContent = stats.monthly_credits_used != null ? `本月已用 ${stats.monthly_credits_used}` : "";
    creditsUsedEl.style.color = "var(--gray-500)";
  }
  const activeLinkEl = $("#statActiveLink");
  if (activeLinkEl) {
    activeLinkEl.textContent = stats.active_tasks > 0 ? "查看进度 →" : "暂无";
    activeLinkEl.style.color = stats.active_tasks > 0 ? "var(--brand)" : "";
    if (stats.active_tasks > 0) {
      activeLinkEl.style.cursor = "pointer";
      activeLinkEl.onclick = () => {
        $$(".nav-item").forEach(item => item.classList.remove("active"));
        const progressTab = document.querySelector('[data-tab="progress"]');
        if (progressTab) { progressTab.classList.add("active"); progressTab.click(); }
      };
    }
  }
  // Result stats
  setStatVal("statTotalResults", state.managedResults.length || "--");
  const recs = state.managedResults.filter(r => r.quality_status === "recommended").length;
  const usable = state.managedResults.filter(r => r.quality_status === "usable").length;
  const repairs = state.managedResults.filter(r => r.quality_status === "repair_needed").length;
  setStatVal("statRecommended", recs || "--");
  setStatVal("statUsable", usable || "--");
  setStatVal("statRepairNeeded", repairs || "--");
}

// ---- Toggle switches ----
function initToggles() {
  $$(".toggle").forEach(toggle => {
    const targetId = toggle.dataset.target;
    const select = $(`#${targetId}`);
    if (!select) return;
    // Sync initial state from select to toggle
    const syncToggle = () => {
      const on = select.value === "true";
      toggle.classList.toggle("on", on);
      toggle.setAttribute("aria-checked", String(on));
    };
    syncToggle();
    // Click handler
    toggle.addEventListener("click", () => {
      select.value = select.value === "true" ? "false" : "true";
      syncToggle();
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Keep toggle in sync if select changes programmatically
    select.addEventListener("change", syncToggle);
  });
}

// ---- Platform chips ----
function initPlatformChips() {
  $$(".platform-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      $$(".platform-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      $("#platformUse").value = chip.dataset.platform;
      $("#platformUse").dispatchEvent(new Event("change", { bubbles: true }));
    });
  });
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
  $("#modelState").className = state.selectedModel ? "badge badge-info" : "badge badge-muted";
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
    $("#garmentState").className = "badge badge-danger";
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
    : `${Math.round(file.size / 1024)} KB · 已上传至服务器`;
  $("#garmentState").textContent = "预检中";
  $("#garmentState").className = "badge badge-info";

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
  $("#garmentState").className = hasBlock ? "badge badge-danger" : "badge badge-success";
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
    $("#modelState").className = "badge badge-danger";
    toast(`真人模特图上传失败：${error.message}`);
    return;
  }
  $("#modelUploadPreview").innerHTML = `<img src="${dataUrl}" alt="模特预览">`;
  $("#modelUploadName").textContent = file.name;
  $("#modelUploadMeta").textContent = uploadedFile.normalized_for_provider
    ? `${Math.round(file.size / 1024)} KB · 已自动生成模型合规图 ${Math.round(uploadedFile.size / 1024)} KB`
    : `${Math.round(file.size / 1024)} KB · 已上传至服务器`;
  $("#modelState").textContent = "验证中";
  $("#modelState").className = "badge badge-info";

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
  $("#modelState").className = uploadedFile.url ? "badge badge-success" : "badge badge-warning";
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
  const agentPanel = $("#agentPanel");
  if (agentPanel) agentPanel.classList.toggle("disabled-panel", !preEditEnabled);
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
  const allPass = !blocking && !warnings;
  $("#preflightState").textContent = blocking ? "有阻断项" : warnings ? "有风险项" : "全部通过";
  $("#preflightState").className = blocking ? "badge badge-danger" : warnings ? "badge badge-warning" : "badge badge-success";

  const iconMap = {
    pass: '<span class="badge badge-success">✓</span>',
    warn: '<span class="badge badge-warning">!</span>',
    block: '<span class="badge badge-danger">✗</span>',
    pending: '<span class="badge badge-muted">○</span>'
  };
  list.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-md);">${checks.map(item => `
    <div class="flex items-center gap-sm">
      ${iconMap[item.status] || iconMap.pending}
      <span class="text-sm" style="font-weight:500;">${item.item}</span>
      <span class="text-xs text-muted">${item.message}</span>
    </div>
  `).join("")}</div>`;
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
      <span class="badge badge-danger">输入不符合要求</span>
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
  // Keep creation form always visible for multi-tasking.
  // Progress details are shown in the 任务进度 tab.
  const progModule = $("#taskProgressModule");
  if (progModule && progModule.style.display === "flex") {
    renderTaskProgressModule(task);
  }
  // Render sidebar
  renderTaskSidebar(task);
  // Results stay in sidebar gallery
  const gallery = $("#resultGallery");
  if (gallery) gallery.innerHTML = renderResultsHtml(task.results || []);
  bindResultActions(task.results || [], gallery || document);
}

function renderTaskSidebar(task) {
  const pct = task.progress || 0;
  const stageLabel = publicTaskStage(task);
  const totalSteps = task.output_type === "video" || task.output_type === "image_video" ? 9 : 6;
  const currentStep = Math.min(Math.ceil(pct / 100 * totalSteps), totalSteps);
  const circ = 2 * Math.PI * 30; // ~188.5
  const offset = circ - (pct / 100) * circ;
  $("#currentTask").innerHTML = `
    <div class="task-card">
      <div style="display:flex;align-items:center;gap:var(--space-lg);padding:var(--space-md);background:var(--gray-50);border-radius:var(--radius-md);">
        <svg width="72" height="72" viewBox="0 0 72 72" style="flex-shrink:0;">
          <circle cx="36" cy="36" r="30" fill="none" stroke="var(--gray-200)" stroke-width="6"/>
          <circle cx="36" cy="36" r="30" fill="none" stroke="var(--brand)" stroke-width="6"
            stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}" stroke-linecap="round"
            transform="rotate(-90 36 36)" style="transition: stroke-dashoffset 0.6s var(--ease);"/>
          <text x="36" y="38" text-anchor="middle" font-size="18" font-weight="700" fill="var(--gray-900)">${pct}%</text>
        </svg>
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--gray-800);">${stageLabel}</div>
          <div class="text-xs text-muted">步骤 ${currentStep} / ${totalSteps}</div>
          <div class="text-xs text-muted">${pct < 100 ? "预计剩余 " + Math.max(1, Math.round((100 - pct) * 1.5)) + " 秒" : "即将完成"}</div>
        </div>
      </div>
      <div style="margin-top:var(--space-md);display:flex;flex-direction:column;gap:8px;">
        <div><span class="text-xs text-muted">任务 ID</span><br><span class="text-sm font-bold">${task.id}</span></div>
        <div><span class="text-xs text-muted">提交时间</span><br><span class="text-sm">${new Date(task.created_at).toLocaleString()}</span></div>
        <div><span class="text-xs text-muted">已用额度</span><br><span class="text-sm font-bold" style="color:var(--brand);">${task.credit_cost ?? "--"} (${isTerminalStatus(task.status) ? "已结算" : "预扣"})</span></div>
        <div><span class="text-xs text-muted">试衣模型</span><br><span class="text-sm">${task.params?.image?.tryon_model || "--"}</span></div>
        <div><span class="text-xs text-muted">品质链路</span><br>${task.params?.quality_strategy ? `<span class="badge badge-info">${task.params.quality_strategy === "commercial" ? "商用品质" : task.params.quality_strategy === "studio" ? "商拍增强" : "快速预览"}</span>` : '<span class="badge badge-muted">未知</span>'}</div>
      </div>
      ${task.status === "failed" ? renderFailureDetail(task) : ""}
    </div>
  `;
  if (isTerminalStatus(task.status)) {
    $("#currentTask").classList.remove("task-empty");
  }
}

function renderTaskProgressModule(task) {
  const pct = task.progress || 0;
  const stageMap = [
    { key: "prechecking", label: "上传预检", icon: "✓" },
    { key: "pre_editing", label: "图像预处理", icon: "✓" },
    { key: "virtual_tryon", label: "试衣生成中", icon: "⟳" },
    { key: "quality_scoring", label: "质量评分", icon: "" },
    { key: "tryon_refining", label: "精修复", icon: "" },
    { key: "quality_gating", label: "质检分≥75", icon: "" },
    { key: "gpt_image_optimizing", label: "高清出图", icon: "" }
  ];
  const videoStages = [
    { key: "generating_keyframes", label: "关键帧生成", icon: "" },
    { key: "rendering_video", label: "视频渲染", icon: "" },
    { key: "encoding", label: "视频导出", icon: "" }
  ];
  const allStages = task.output_type === "video" || task.output_type === "image_video"
    ? [...stageMap, ...videoStages]
    : stageMap;

  const currentStageIdx = (() => {
    const stage = task.current_stage || "";
    if (task.status === "completed") return allStages.length;
    if (task.status === "failed") return -1;
    const idx = allStages.findIndex(s => s.key === stage);
    return idx >= 0 ? idx : Math.min(Math.floor(pct / 100 * allStages.length), allStages.length - 1);
  })();

  const pipelineHtml = allStages.map((s, i) => {
    let cls = "";
    let label = s.label;
    const isGptImage = task.params?.image?.tryon_model === "gpt-image:try-on" || task.params?.image?.tryon_model === "gpt-image:tryon";
    if (isGptImage && (s.key === "pre_editing" || s.key === "tryon_refining")) {
      cls = "pipeline-step"; // skipped, shown as pending
    }
    if (task.status === "failed" && i === currentStageIdx && currentStageIdx >= 0) {
      cls = "pipeline-step fail";
      label = "✕ " + s.label;
    } else if (task.status === "failed" && i > currentStageIdx) {
      cls = "pipeline-step";
      label = s.label;
    } else if (i < currentStageIdx) {
      cls = "pipeline-step done";
      label = "✓ " + s.label;
    } else if (i === currentStageIdx && task.status !== "completed" && task.status !== "failed") {
      cls = "pipeline-step active";
      label = "⟳ " + s.label;
    } else {
      cls = "pipeline-step";
    }
    const afterFail = task.status === "failed" && i >= currentStageIdx && currentStageIdx >= 0;
    const stepStyle = afterFail && i > currentStageIdx ? "opacity:.4;" : "";
    const arrowStyle = afterFail && i < allStages.length - 1 ? ' style="color:var(--gray-200);"' : "";
    return `<span class="${cls}"${stepStyle ? ` style="${stepStyle}"` : ""}>${label}</span>${i < allStages.length - 1 ? `<span class="pipeline-arrow"${arrowStyle}>→</span>` : ""}`;
  }).join("");

  // Build timeline from events
  const events = task.events || [];
  const timelineItems = events.length ? events.map((evt, i) => {
    let itemClass = "done";
    if (i === events.length - 1 && !isTerminalStatus(task.status)) itemClass = "active";
    if (evt.status === "failed" || (task.status === "failed" && i === events.length - 1)) itemClass = "fail";
    return `<div class="timeline-item ${itemClass}"><strong>${publicTaskStage({ current_stage: evt.status, status: "processing" })}</strong><span>${new Date(evt.created_at).toLocaleTimeString("zh-CN")}${evt.message ? " · " + evt.message : ""}</span></div>`;
  }).join("") : `
    <div class="timeline-item active"><strong>任务已提交</strong><span>${new Date(task.created_at).toLocaleTimeString("zh-CN")} · 等待开始</span></div>
  `;

  const desc = task.output_type === "video" ? "视频任务" : task.output_type === "image_video" ? "图片+视频 · 商用品质链路" : "图片任务";
  const modelLabel = task.params?.image?.tryon_model || "";

  const prog = $("#taskProgressModule");
  if (!prog) return;
  prog.innerHTML = `
    <div class="card">
      <div class="flex justify-between items-center">
        <div><h2 style="font-size:18px;font-weight:600;">任务 ${task.id}</h2><p class="text-sm text-muted">${desc}${modelLabel ? " · " + modelLabel : ""}</p></div>
        <div style="text-align:right;">
          ${statusBadge(task.status)}
          <p class="text-xs text-muted mt-sm">${pct < 100 ? "预计剩余 " + Math.max(1, Math.round((100 - pct) * 1.5)) + " 秒" : "即将完成"}</p>
        </div>
      </div>
      <div class="progress-bar mt-md" style="height:8px;border-radius:4px;"><div class="progress-fill" style="width:${pct}%;"></div></div>
    </div>

    <div class="card"${task.status === "failed" ? ' style="border:1px solid #FECACA;"' : ""}>
      <div class="card-header"><div><h2>品质管线 Quality Pipeline</h2><p>${task.params?.quality_strategy === "commercial" ? "商用品质链路" : task.params?.quality_strategy === "studio" ? "商拍增强链路" : "快速预览链路"}：候选生成 → 质量评分 → 精修 → 质检 → 高清出图${task.status === "failed" ? " · 检测到失败步骤" : ""}</p></div>${task.status === "failed" ? '<span class="badge badge-danger">任务失败</span>' : ""}</div>
      <div class="pipeline" style="flex-wrap:wrap;">${pipelineHtml}</div>
      ${task.status === "failed" ? `<div class="alert alert-danger mt-md">${task.failure_reason || "模型生成失败，请重试或更换素材。"}</div><div class="flex gap-sm mt-md"><button class="btn btn-primary btn-sm" data-retry-task="${task.id}">重新提交</button><button class="btn btn-secondary btn-sm" data-retry-params="${task.id}">更换服装图</button></div>` : ""}
    </div>

    <div class="card">
      <div class="card-header"><div><h2>执行时间线</h2><p>实时更新各步骤状态与耗时</p></div></div>
      <div class="timeline">${timelineItems}</div>
    </div>
  `;
  // Bind result actions in progress view
  if (task.results?.length) {
    bindResultActions(task.results, prog);
  }
}

function publicTaskStage(task) {
  const stage = task?.current_stage || task?.status || "pending";
  const map = {
    pending: "素材检查中",
    prechecking: "素材检查中",
    pre_editing: "素材处理中",
    virtual_tryon: "虚拟试衣中",
    tryon_refining: "精修复中",
    effect_validating: "商品一致性检查中",
    quality_scoring: "质量评分中",
    quality_gating: "质检分≥75 判定中",
    gpt_image_optimizing: "高清出图中",
    generating_keyframes: "视频关键帧生成中",
    rendering_video: "视频渲染中",
    frame_checking: "视频帧检查中",
    encoding: "视频导出中",
    completed: "生成完成",
    failed: "生成失败",
    cancelled: "任务已取消"
  };
  if (task?.status === "completed") return "生成完成";
  if (task?.status === "failed") return "生成失败";
  if (task?.status === "cancelled") return "任务已取消";
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
        ${result.model_meta?.provider === "mock" ? `<span class="badge badge-warning">模拟结果，不是真实试衣</span>` : ""}
        ${result.model_meta?.openai_image_optimizer_rejected ? `<span class="badge badge-warning">最终商用出图未通过，已回退到试衣精修图</span>` : result.model_meta?.openai_image_optimizer ? `<span class="badge badge-success">已完成最终商用出图</span>` : ""}
        <span>商用综合分：${result.score} ${result.duration_seconds ? `· ${result.duration_seconds}秒` : ""}</span>
        ${result.quality_report ? `<span>自然度 ${result.quality_report.garment_naturalness} · 一致性 ${result.quality_report.garment_consistency} · 清晰度 ${result.quality_report.clarity}</span>` : ""}
        <span>高清状态：${result.hd_status || "待处理"} · ${result.download_allowed === false ? "不可下载" : "可下载"}</span>
        ${result.issue_tags?.length ? `<div class="issue-tags">${result.issue_tags.map(tag => `<span>${tag}</span>`).join("")}</div>` : ""}
        <div class="result-actions">
          <button class="secondary-btn" data-preview="${result.id}">查看效果</button>
          <button class="secondary-btn" data-open-result="${result.id}" ${result.download_allowed === false ? "disabled" : ""}>下载/打开</button>
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
    $("#currentTask").innerHTML = `
      <div style="display:flex;flex-direction:column;gap:var(--space-md);">
        <div class="flex justify-between"><span class="text-sm text-muted">服装品类</span><span class="text-sm text-muted">--</span></div>
        <div class="flex justify-between"><span class="text-sm text-muted">模特来源</span><span class="text-sm text-muted">--</span></div>
        <div class="flex justify-between"><span class="text-sm text-muted">输出类型</span><span class="text-sm text-muted">--</span></div>
        <div class="flex justify-between"><span class="text-sm text-muted">预计生成数</span><span class="text-sm text-muted">--</span></div>
        <div class="flex justify-between"><span class="text-sm text-muted">品质链路</span><span class="badge badge-muted">--</span></div>
        <div class="flex justify-between" style="padding-top:var(--space-md);border-top:1px solid var(--gray-100);"><span class="text-sm text-muted">预估额度</span><span style="font-size:20px;font-weight:700;color:var(--brand);">--</span></div>
      </div>`;
    $("#currentTask").className = "task-empty";
    renderResults([]);
    const progModule = $("#taskProgressModule");
    const wfMain = document.querySelector(".workflow-main");
    if (progModule) progModule.style.display = "none";
    if (wfMain) wfMain.style.display = "";
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
    // Also refresh progress tab if it's the active panel
    const progressPanel = $("#progressTab");
    if (progressPanel && progressPanel.classList.contains("active")) {
      renderProgressTab();
    }
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

  const activeFilter = state.historyFilter || "all";
  const searchQuery = (state.historySearch || "").toLowerCase();
  let filtered = tasks;
  if (activeFilter !== "all") {
    filtered = tasks.filter(t => {
      if (activeFilter === "processing") return !isTerminalStatus(t.status);
      return t.status === activeFilter;
    });
  }
  if (searchQuery) {
    filtered = filtered.filter(t => t.id.toLowerCase().includes(searchQuery));
  }

  // Update chip counts
  $$("#historyFilters .chip").forEach(chip => {
    const f = chip.dataset.historyFilter;
    let count = tasks.length;
    if (f === "all") count = tasks.length;
    else if (f === "processing") count = tasks.filter(t => !isTerminalStatus(t.status)).length;
    else count = tasks.filter(t => t.status === f).length;
    chip.textContent = chip.textContent.replace(/\s*\(\d+\)\s*$/, "") + ` (${count})`;
  });

  if (!filtered.length) {
    $("#taskHistory").innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><strong>暂无任务</strong><p>提交生成任务后将在此处显示</p></div>`;
  } else {
    const qualitySummary = (task) => {
      const s = task.quality_summary;
      if (!s) return "暂无数据";
      return `${s.recommended_count || 0}推荐 · ${s.usable_count || 0}可用 · ${s.repair_needed_count || 0}待修复`;
    };
    const taskDesc = (task) => {
      const model = task.params?.image?.tryon_model || "";
      let modelName = model;
      if (model === "pixelcut:try-on") modelName = "Pixelcut";
      else if (model === "gpt-image:try-on" || model === "gpt-image:tryon" || model === "gpt-image") modelName = "GPT-Image 1.5";
      else if (model === "302:fashn-tryon") modelName = "302.AI FASHN";
      else if (model === "aliyun:aitryon-plus") modelName = "百炼 Plus";
      else if (model === "pixazo:fashn-vton") modelName = "Pixazo Fashn";
      else if (model === "replicate:idm-vton") modelName = "IDM-VTON";
      const parts = [task.output_type === "video" ? "视频" : task.output_type === "image_video" ? "图+视频" : "图片"];
      if (modelName) parts.push(modelName);
      return parts.join(" · ");
    };
    const garmentLabel = (task) => {
      if (!task.garment) return "--";
      return task.garment.category_label || task.garment.category || "--";
    };
    const modelLabel = (task) => {
      if (!task.model) return "--";
      return task.model.name || task.model.id || "--";
    };
    const taskDuration = (task) => {
      if (!isTerminalStatus(task.status) || !task.created_at || !task.updated_at) return "进行中";
      const secs = Math.round((new Date(task.updated_at) - new Date(task.created_at)) / 1000);
      return secs >= 60 ? `${Math.round(secs / 60)} 分 ${secs % 60} 秒` : `${secs} 秒`;
    };
    const rows = filtered.map(task => `
      <div class="table-row history-task-row" style="grid-template-columns:36px 1fr 100px 120px 80px 80px 40px;cursor:pointer;" data-expand-task="${task.id}">
        <input type="checkbox" data-select-task="${task.id}" ${state.selectedTaskIds?.has(task.id) ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--brand);">
        <div><strong>${task.id}</strong><span class="text-xs text-muted" style="display:block;">${taskDesc(task)}</span></div>
        ${statusBadge(task.status)}
        <span class="text-sm text-muted">${new Date(task.created_at).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
        <span class="text-sm">${task.credit_cost ?? "--"}</span>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger);" data-delete-task="${task.id}">删除</button>
        <span style="color:var(--gray-400);cursor:pointer;font-size:14px;user-select:none;" data-expand-task="${task.id}">${state.expandedHistoryTaskId === task.id ? "▾" : "▸"}</span>
      </div>
      ${state.expandedHistoryTaskId === task.id ? `
        <div class="expand-row">
          <div class="expand-grid">
            <div><span class="text-xs text-muted">服装品类</span><br><span class="text-sm">${garmentLabel(task)}</span></div>
            <div><span class="text-xs text-muted">模特</span><br><span class="text-sm">${modelLabel(task)}</span></div>
            <div><span class="text-xs text-muted">试衣模型</span><br><span class="text-sm">${task.params?.image?.tryon_model || "--"}</span></div>
            <div><span class="text-xs text-muted">品质链路</span><br><span class="text-sm">${task.params?.quality_strategy || "--"}</span></div>
            <div><span class="text-xs text-muted">生成结果</span><br><span class="text-sm">${qualitySummary(task)}</span></div>
            <div><span class="text-xs text-muted">耗时</span><br><span class="text-sm">${taskDuration(task)}</span></div>
          </div>
          ${task.results?.length ? `<div class="result-gallery mt-md" style="grid-template-columns:repeat(3, minmax(0, 1fr));">${renderResultsHtml(task.results)}</div>` : ""}
          <div class="flex gap-sm mt-md">
            ${task.results?.length ? `<button class="btn btn-secondary btn-sm" data-view-results="${task.id}">查看结果</button>` : ""}
            ${!isTerminalStatus(task.status) ? `<button class="btn btn-ghost btn-sm" data-cancel-task="${task.id}" style="color:var(--danger);">取消任务</button>` : ""}
            <button class="btn btn-ghost btn-sm" data-view-task="${task.id}">收起详情</button>
          </div>
        </div>
      ` : ""}
    `).join("");
    $("#taskHistory").innerHTML = `<div class="table-row header" style="grid-template-columns:36px 1fr 100px 120px 80px 80px 40px;"><span></span><span>任务信息</span><span>状态</span><span>时间</span><span>额度</span><span></span><span></span></div>${rows}`;
  }

  // Checkbox selection
  $$("[data-select-task]").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      if (!state.selectedTaskIds) state.selectedTaskIds = new Set();
      if (checkbox.checked) {
        state.selectedTaskIds.add(checkbox.dataset.selectTask);
      } else {
        state.selectedTaskIds.delete(checkbox.dataset.selectTask);
      }
      updateBatchDeleteTasksButton();
    });
  });

  // Expand/collapse row — click anywhere on the row to toggle
  $$(".history-task-row").forEach(row => {
    row.addEventListener("click", (e) => {
      // Don't toggle when clicking checkboxes, buttons, or links
      if (e.target.closest("button, input, a, [data-delete-task], [data-select-task]")) return;
      state.expandedHistoryTaskId = state.expandedHistoryTaskId === row.dataset.expandTask ? null : row.dataset.expandTask;
      loadTasks();
    });
  });

  // View/collapse task
  $$("[data-view-task]").forEach(button => {
    button.addEventListener("click", async () => {
      state.expandedHistoryTaskId = null;
      await loadTasks();
    });
  });

  // Single delete
  $$("[data-delete-task]").forEach(button => {
    button.addEventListener("click", async () => {
      if (!window.confirm("确认删除该任务及其结果吗？")) return;
      try {
        await api(`/v1/tryon/tasks/${button.dataset.deleteTask}`, { method: "DELETE" });
        toast("任务已删除");
        await loadTasks();
      } catch (error) {
        toast(`删除失败：${error.message}`);
      }
    });
  });

  // Bind result actions in expanded rows
  $$(".expand-row .result-card").forEach(card => {
    // Find the parent task by locating the expand-row's preceding table-row
    const expandRow = card.closest(".expand-row");
    if (!expandRow) return;
    const taskRow = expandRow.previousElementSibling;
    if (!taskRow) return;
    const checkbox = taskRow.querySelector("[data-select-task]");
    if (!checkbox) return;
    const taskId = checkbox.dataset.selectTask;
    const task = filtered.find(t => t.id === taskId);
    if (task) bindResultActions(task.results || [], expandRow);
  });

  const expandedTask = tasks.find(task => task.id === state.expandedHistoryTaskId);
  if (expandedTask && !isTerminalStatus(expandedTask.status)) {
    state.historyPollTimer = setTimeout(loadTasks, 2000);
  }

  updateBatchDeleteTasksButton();
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
  loadStats();
}

function updateBatchDeleteButton() {
  const btn = $("#batchDeleteResultsBtn");
  const dlBtn = $("#batchDownloadResultsBtn");
  if (btn) btn.disabled = state.selectedResultIds.size === 0;
  if (dlBtn) dlBtn.disabled = state.selectedResultIds.size === 0;
}

function renderManagedResults() {
  const rows = state.resultFilter === "all"
    ? state.managedResults
    : state.managedResults.filter(item => item.quality_status === state.resultFilter);
  state.selectedResultIds.clear();
  updateBatchDeleteButton();

  // Update result chip counts
  $$("#resultChips .chip").forEach(chip => {
    const f = chip.dataset.resultFilter;
    let count = state.managedResults.length;
    if (f === "all") count = state.managedResults.length;
    else if (f === "unusable") count = state.managedResults.filter(r => r.quality_status === "unusable").length;
    else count = state.managedResults.filter(r => r.quality_status === f).length;
    chip.textContent = chip.textContent.replace(/\s*\(\d+\)\s*$/, "") + ` (${count})`;
  });
  if (!rows.length) {
    $("#resultManager").innerHTML = `<div class="empty-state"><div class="empty-icon">📷</div><strong>暂无该分组结果</strong><p>生成完成的结果将在此处展示</p></div>`;
    return;
  }
  const cards = rows.map(result => `
    <div class="result-card ${state.selectedResultIds.has(result.id) ? 'selected' : ''}" data-result-id="${result.id}">
      <input type="checkbox" class="result-checkbox" data-select-result="${result.id}" ${state.selectedResultIds.has(result.id) ? 'checked' : ''}>
      <div class="result-card-img">
        ${result.media_type === "video"
          ? `<video src="${mediaUrl(result.video_url)}" poster="${mediaUrl(result.cover_url)}" muted playsinline></video>`
          : `<img src="${mediaUrl(result.image_url || result.cover_url)}" alt="结果图">`}
        <div class="hover-overlay">
          <button class="btn btn-primary btn-sm" data-preview-managed="${result.id}">预览大图</button>
          <button class="btn btn-secondary btn-sm" data-download-managed="${result.id}" ${result.download_allowed === false ? "disabled" : ""}>下载</button>
        </div>
      </div>
      <div style="padding:var(--space-sm) var(--space-md);display:flex;flex-direction:column;gap:2px;">
        <span class="text-xs text-muted">${(result.task_id || result.task?.id || "").slice(0, 22)}</span>
        <span class="text-xs text-muted">${new Date(result.created_at).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})}</span>
      </div>
      <div class="result-card-footer">
        ${qualityBadge(result.quality_status)}
        <span class="text-xs text-muted">${result.score ? result.score + "分" : ""}</span>
      </div>
    </div>
  `).join("");
  $("#resultManager").innerHTML = `<div class="result-grid">${cards}</div>`;

  // Card click to select
  $$(".result-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("input")) return;
      const cb = card.querySelector(".result-checkbox");
      if (cb) {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      }
      card.classList.toggle("selected", cb?.checked);
    });
  });

  // Checkbox selection
  $$("[data-select-result]").forEach(checkbox => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.selectedResultIds.add(checkbox.dataset.selectResult);
      } else {
        state.selectedResultIds.delete(checkbox.dataset.selectResult);
      }
      updateBatchDeleteButton();
    });
  });

  // Preview
  $$("[data-preview-managed]").forEach(button => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const result = state.managedResults.find(item => item.id === button.dataset.previewManaged);
      if (result) openMediaModal(result);
    });
  });

  // Download
  $$("[data-download-managed]").forEach(button => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const data = await api(`/v1/tryon/results/${button.dataset.downloadManaged}/download`);
        window.open(mediaUrl(data.signed_url), "_blank", "noopener,noreferrer");
      } catch (error) {
        toast(error.message);
      }
    });
  });

  // Single delete
  $$("[data-delete-managed]").forEach(button => {
    button.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm("确认删除该结果吗？")) return;
      try {
        await api(`/v1/tryon/results/${button.dataset.deleteManaged}`, { method: "DELETE" });
        toast("结果已删除");
        await loadManagedResults();
      } catch (error) {
        toast(`删除失败：${error.message}`);
      }
    });
  });
}

async function batchDownloadResults() {
  if (!state.selectedResultIds.size) return;
  toast(`正在准备下载 ${state.selectedResultIds.size} 个结果...`);
  for (const id of state.selectedResultIds) {
    try {
      const data = await api(`/v1/tryon/results/${encodeURIComponent(id)}/download`);
      window.open(mediaUrl(data.signed_url), "_blank", "noopener,noreferrer");
    } catch {
      // skip failed downloads
    }
  }
}

async function batchDeleteResults() {
  if (!state.selectedResultIds.size) return;
  if (!window.confirm(`确认删除选中的 ${state.selectedResultIds.size} 个结果吗？此操作不可撤销。`)) return;
  try {
    const data = await api("/v1/tryon/results/batch-delete", {
      method: "POST",
      body: JSON.stringify({ ids: [...state.selectedResultIds] })
    });
    toast(`已删除 ${data.deleted} 个结果`);
    state.selectedResultIds.clear();
    updateBatchDeleteButton();
    await loadManagedResults();
  } catch (error) {
    toast(`批量删除失败：${error.message}`);
  }
}

function toggleSelectAllResults() {
  const checkboxes = $$("[data-select-result]");
  const allSelected = checkboxes.length && checkboxes.every(cb => cb.checked);
  checkboxes.forEach(cb => {
    cb.checked = !allSelected;
    if (!allSelected) {
      state.selectedResultIds.add(cb.dataset.selectResult);
    } else {
      state.selectedResultIds.delete(cb.dataset.selectResult);
    }
  });
  // Update card selected state
  $$(".result-card").forEach(card => {
    const cb = card.querySelector(".result-checkbox");
    card.classList.toggle("selected", cb?.checked);
  });
  updateBatchDeleteButton();
}

function updateBatchDeleteTasksButton() {
  const btn = $("#batchDeleteTasksBtn");
  if (btn) btn.disabled = !(state.selectedTaskIds?.size > 0);
}

async function batchDeleteTasks() {
  if (!state.selectedTaskIds?.size) return;
  if (!window.confirm(`确认删除选中的 ${state.selectedTaskIds.size} 个任务吗？此操作不可撤销。`)) return;
  let deleted = 0;
  for (const id of state.selectedTaskIds) {
    try {
      await api(`/v1/tryon/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      deleted++;
    } catch {
      // continue
    }
  }
  toast(`已删除 ${deleted} 个任务`);
  state.selectedTaskIds = new Set();
  updateBatchDeleteTasksButton();
  await loadTasks();
}

async function loadCreditLogs() {
  const logs = await api("/v1/credits/logs");
  const container = $("#creditLogs");
  if (!container) return;
  container.innerHTML = logs.length ? logs.map(log => `
    <div class="list-row">
      <div>
        <strong>${log.amount} 额度 · ${log.reason}</strong>
        <small>${log.task_id} · ${log.status} · ${new Date(log.created_at).toLocaleString()}</small>
      </div>
      <span class="badge ${log.direction === "debit" ? "badge-warning" : "badge-success"}">${log.direction}</span>
    </div>
  `).join("") : `<div class="task-empty">暂无额度流水</div>`;
}

async function refreshTabData(tabName) {
  if (tabName !== "history" && state.historyPollTimer) {
    clearTimeout(state.historyPollTimer);
    state.historyPollTimer = null;
  }
  if (tabName === "create") {
    await Promise.allSettled([loadHealth(), loadCapabilities(), loadModels(), loadCredits(), loadTasks(), loadStats()]);
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
  if (tabName === "progress") {
    await loadTasks();
    renderProgressTab();
    return;
  }
  if (tabName === "credits") {
    await Promise.allSettled([loadCapabilities(), loadCredits()]);
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

// ── v2.0: Auth-first init ──
async function init() {
  // Bind auth-related events (always available)
  const loginForm = document.getElementById("loginForm");
  if (loginForm) loginForm.addEventListener("submit", handleLogin);
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  const changePwdBtn = document.getElementById("changePasswordBtn");
  if (changePwdBtn) changePwdBtn.addEventListener("click", openChangePasswordModal);

  // Remember me hint toggle
  const rememberCb = document.getElementById("loginRemember");
  const rememberHint = document.getElementById("loginRememberHint");
  if (rememberCb && rememberHint) {
    const updateHint = () => {
      rememberHint.textContent = rememberCb.checked ? "30 天内无需重新登录" : "7 天内保持登录";
      rememberHint.style.color = rememberCb.checked ? "var(--success)" : "";
      rememberHint.style.fontWeight = rememberCb.checked ? "500" : "";
    };
    rememberCb.addEventListener("change", updateHint);
  }
  const changePwdForm = document.getElementById("changePasswordForm");
  if (changePwdForm) changePwdForm.addEventListener("submit", handleChangePassword);
  const pwdChangedBtn = document.getElementById("passwordChangedLoginBtn");
  if (pwdChangedBtn) pwdChangedBtn.addEventListener("click", hidePasswordChanged);

  // Close modals via backdrop/button clicks
  document.querySelectorAll("[data-close-pwd-modal]").forEach(el => {
    el.addEventListener("click", closeChangePasswordModal);
  });

  // Try to restore session from stored token
  const storedToken = loadStoredToken();
  if (storedToken) {
    auth.refreshToken = storedToken;
    try {
      const newToken = await refreshAccessToken();
      auth.accessToken = newToken;
      const user = await api("/v1/auth/me");
      auth.user = user;
      showApp();
      await initApp();
      return;
    } catch {
      clearTokens();
    }
  }
  showLogin();
}

async function initApp() {
  bindTabs();
  initToggles();
  initPlatformChips();

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
  $("#batchDownloadResultsBtn").addEventListener("click", batchDownloadResults);
  $("#batchDeleteResultsBtn").addEventListener("click", batchDeleteResults);
  $("#selectAllResultsBtn").addEventListener("click", toggleSelectAllResults);
  $("#batchDeleteTasksBtn").addEventListener("click", batchDeleteTasks);

  // Result filter chips
  $$("#resultChips .chip").forEach(button => {
    button.addEventListener("click", async () => {
      $$("#resultChips .chip").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      state.resultFilter = button.dataset.resultFilter;
      renderManagedResults();
    });
  });

  // History filter chips
  $$("#historyFilters .chip").forEach(button => {
    button.addEventListener("click", async () => {
      $$("#historyFilters .chip").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      state.historyFilter = button.dataset.historyFilter;
      await loadTasks();
    });
  });

  // Task search
  $("#taskSearchInput").addEventListener("input", () => {
    state.historySearch = $("#taskSearchInput").value;
    loadTasks();
  });

  // Model library filters
  $$("#modelLibraryFilters .chip").forEach(button => {
    button.addEventListener("click", () => {
      $$("#modelLibraryFilters .chip").forEach(item => item.classList.remove("active"));
      button.classList.add("active");
      renderModelLibraryFiltered();
    });
  });
  $("#libraryBodyFilter").addEventListener("change", renderModelLibraryFiltered);
  $("#libraryPoseFilter").addEventListener("change", renderModelLibraryFiltered);

  // Reset library form button also switches to new model mode
  $("#resetLibraryFormBtn").addEventListener("click", () => {
    resetModelLibraryForm();
    $("#modelsTab").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // "浏览全部" button in model quick-select
  $("#browseAllModelsBtn").addEventListener("click", () => {
    $$(".nav-item").forEach(item => item.classList.remove("active"));
    const modelsTab = document.querySelector('[data-tab="models"]');
    if (modelsTab) {
      modelsTab.classList.add("active");
      modelsTab.click();
    }
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

  // Progress tab event delegation
  $("#progressMain").addEventListener("click", async (e) => {
    const retryBtn = e.target.closest("[data-retry-task]");
    const cancelBtn = e.target.closest("[data-cancel-progress]");
    if (retryBtn) {
      toast("重试功能开发中，请重新提交任务");
    }
    if (cancelBtn) {
      if (!window.confirm("确认取消该任务吗？")) return;
      try {
        await api(`/v1/tryon/tasks/${cancelBtn.dataset.cancelProgress}/cancel`, { method: "POST" });
        toast("任务已取消");
        await loadTasks();
        renderProgressTab();
      } catch (err) {
        toast(`取消失败：${err.message}`);
      }
    }
  });
  $("#progressSidebar").addEventListener("click", async (e) => {
    const retryBtn = e.target.closest("[data-retry-task]");
    const cancelBtn = e.target.closest("[data-cancel-progress]");
    if (retryBtn) {
      toast("重试功能开发中，请重新提交任务");
    }
    if (cancelBtn) {
      if (!window.confirm("确认取消该任务吗？")) return;
      try {
        await api(`/v1/tryon/tasks/${cancelBtn.dataset.cancelProgress}/cancel`, { method: "POST" });
        toast("任务已取消");
        await loadTasks();
        renderProgressTab();
      } catch (err) {
        toast(`取消失败：${err.message}`);
      }
    }
  });

  await loadHealth();
  await loadCapabilities();
  await loadModels();
  await loadCredits();
  await loadTasks();
  await loadStats();
  renderGarmentReferenceImages();
  updateSubmitState();
  updatePreEditHint();
  updateRefinerHint();
  updateQualityStrategyHint();
  updatePostOptimizeHint();
}

function renderModelLibraryFiltered() {
  const activeGender = ($("#modelLibraryFilters .chip.active")?.dataset?.modelGender) || "all";
  const bodyFilter = ($("#libraryBodyFilter")?.value) || "all";
  const poseFilter = ($("#libraryPoseFilter")?.value) || "all";
  let models = state.models;
  if (activeGender !== "all") models = models.filter(m => m.gender === activeGender);
  if (bodyFilter !== "all") models = models.filter(m => m.body_type === bodyFilter);
  if (poseFilter !== "all") models = models.filter(m => m.pose_type === poseFilter);
  const target = $("#modelLibrary");
  if (!target) return;
  target.innerHTML = models.map(model => `
    <div class="model-card library-card" data-model-id="${model.id}">
      <button class="quick-delete" data-delete-library-model="${model.id}" title="删除模特">×</button>
              <div class="model-card-img" data-preview-model="${model.id}" style="cursor:pointer;${model.preview_url ? "" : `background: linear-gradient(135deg, ${model.preview_color || "#2563eb"}, var(--surface-alt));`}">
              ${model.preview_url ? `<img src="${mediaUrl(model.preview_url)}" alt="${model.name}">` : model.name}
              </div>
      <div class="model-card-body">
        <strong>${model.name}</strong>
        <span>${model.gender === "female" ? "女" : model.gender === "male" ? "男" : "模特"} · ${model.body_type} · ${model.pose_type}</span>
        <div class="flex gap-sm mt-sm">${(model.categories || []).map(c => `<span class="badge badge-info">${c}</span>`).join("") || '<span class="badge badge-muted">通用</span>'}</div>
        <div class="library-card-meta">
          <span class="badge ${model.source === "system" ? "badge-info" : "badge-success"}">${model.source === "system" ? "系统默认" : "自定义"}</span>
          ${model.video_enabled ? '<span class="badge badge-success">视频可用</span>' : ""}
        </div>
        <button class="btn btn-secondary btn-sm" data-edit-library-model="${model.id}" style="width:100%;">修改</button>
      </div>
    </div>
  `).join("");
  // Re-bind handlers
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
        id: model.id, media_type: "image",
        image_url: model.preview_url, cover_url: model.preview_url
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

init().catch(error => {
  setApiStatus(false);
  toast(error.message);
});
