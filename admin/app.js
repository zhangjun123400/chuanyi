const API_BASE = window.API_BASE || `${window.location.protocol}//${window.location.hostname}:4000`;
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

// ── Auth state ──
const auth = { accessToken: null, refreshToken: null, user: null };
let refreshPromise = null;

function saveTokens(accessToken, refreshToken, rememberMe) {
  auth.accessToken = accessToken;
  auth.refreshToken = refreshToken;
  if (rememberMe) {
    localStorage.setItem("admin.refreshToken", refreshToken);
    localStorage.setItem("admin.rememberMe", "1");
  } else {
    sessionStorage.setItem("admin.refreshToken", refreshToken);
    localStorage.removeItem("admin.rememberMe");
  }
}

function loadStoredToken() {
  return {
    refreshToken: localStorage.getItem("admin.refreshToken") || sessionStorage.getItem("admin.refreshToken")
  };
}

function clearTokens() {
  auth.accessToken = null; auth.refreshToken = null; auth.user = null;
  localStorage.removeItem("admin.refreshToken");
  sessionStorage.removeItem("admin.refreshToken");
  localStorage.removeItem("admin.rememberMe");
}

// ── API with auth interceptor ──
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (auth.accessToken) headers["Authorization"] = `Bearer ${auth.accessToken}`;

  let res = await fetch(`${API_BASE}${path}`, { headers, ...options });

  if (res.status === 401 && auth.refreshToken) {
    try {
      auth.accessToken = await refreshAccessToken();
      headers["Authorization"] = `Bearer ${auth.accessToken}`;
      res = await fetch(`${API_BASE}${path}`, { headers, ...options });
    } catch {
      clearTokens();
      showAdminLogin();
      throw new Error("登录已过期，请重新登录");
    }
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.message || payload.error || "请求失败");
    err.payload = payload;
    throw err;
  }
  return payload.data;
}

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
      if (localStorage.getItem("admin.rememberMe")) {
        localStorage.setItem("admin.refreshToken", refresh_token);
      } else {
        sessionStorage.setItem("admin.refreshToken", refresh_token);
      }
      return access_token;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

// ── Toast ──
function toast(message) {
  let el = document.getElementById("adminToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "adminToast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}

// ── UI state ──
function showAdminLogin() {
  document.getElementById("adminLoginOverlay").style.display = "";
  document.getElementById("identityConfirmOverlay").classList.add("hidden");
  document.getElementById("adminConsole").classList.add("hidden");
  document.getElementById("adminLoginError").classList.add("hidden");
}

let identityTimer = null;

function showIdentityConfirm(user) {
  document.getElementById("adminLoginOverlay").style.display = "none";
  document.getElementById("identityConfirmOverlay").classList.remove("hidden");
  document.getElementById("identityUserName").textContent = user.name;
  document.getElementById("identityUserRole").textContent = user.role === "admin" ? "系统管理员" : "运营";

  // 2-second countdown auto-enter
  let remaining = 2;
  const countdownEl = document.getElementById("identityCountdown");
  countdownEl.textContent = `${remaining} 秒后自动进入...`;
  if (identityTimer) clearInterval(identityTimer);
  identityTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(identityTimer);
      identityTimer = null;
      enterAdminConsole();
    } else {
      countdownEl.textContent = `${remaining} 秒后自动进入...`;
    }
  }, 1000);
}

function enterAdminConsole() {
  if (identityTimer) { clearInterval(identityTimer); identityTimer = null; }
  showAdminConsole();
  switchAdminTab("users");
}

function showAdminConsole() {
  document.getElementById("identityConfirmOverlay").classList.add("hidden");
  document.getElementById("adminConsole").classList.remove("hidden");
  document.getElementById("adminUserName").textContent = auth.user.name;
}

// ── Login ──
async function handleAdminLogin(e) {
  e.preventDefault();
  const btn = document.getElementById("adminLoginSubmitBtn");
  const errorEl = document.getElementById("adminLoginError");
  btn.disabled = true;
  btn.classList.add("loading");
  errorEl.classList.add("hidden");

  try {
    const res = await fetch(`${API_BASE}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("adminLoginEmail").value.trim(),
        password: document.getElementById("adminLoginPassword").value,
        remember_me: document.getElementById("adminLoginRemember").checked
      })
    });
    const payload = await res.json();
    if (!res.ok) {
      let msg = payload.message || "登录失败";
      if (payload.remaining_attempts != null) {
        msg += payload.remaining_attempts > 0
          ? `，剩余 ${payload.remaining_attempts} 次尝试`
          : "，账号已临时锁定，请15分钟后重试";
      }
      throw new Error(msg);
    }

    const { access_token, refresh_token, user } = payload.data;
    if (user.role !== "admin") {
      alert("您的账号非管理员角色，即将跳转至工作台。");
      window.location.href = `${window.location.protocol}//${window.location.hostname}:3000`;
      return;
    }

    auth.accessToken = access_token;
    auth.refreshToken = refresh_token;
    auth.user = user;
    saveTokens(access_token, refresh_token, document.getElementById("adminLoginRemember").checked);

    showIdentityConfirm(user);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

async function handleAdminLogout() {
  try {
    if (auth.refreshToken) {
      await api("/v1/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: auth.refreshToken })
      }).catch(() => {});
    }
  } finally {
    clearTokens();
    showAdminLogin();
  }
}

// ── User management ──
let userPage = 1;
const USER_PAGE_SIZE = 10;

async function loadUsers(query) {
  const container = document.getElementById("userTableContainer");
  container.innerHTML = '<div class="skeleton-table">' + Array(6).fill('<div class="skeleton-row"></div>').join("") + '</div>';

  try {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    params.set("page", String(userPage));
    params.set("page_size", String(USER_PAGE_SIZE));
    const data = await api(`/v1/admin/users?${params.toString()}`);
    const users = data.users || data;
    renderUserTable(users);
    renderUserPagination(data.total || users.length);
    updateUserCount();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">加载失败：${err.message}</div>`;
  }
}

function renderUserTable(users) {
  if (!users.length) {
    document.getElementById("userTableContainer").innerHTML = `
      <div style="padding:var(--space-2xl);text-align:center;">
        <div style="font-size:40px;margin-bottom:var(--space-sm);">📭</div>
        <strong style="display:block;margin-bottom:var(--space-xs);">暂无用户</strong>
        <p class="text-xs text-muted" style="margin-bottom:var(--space-lg);">这是新部署的系统，还没有创建任何用户</p>
        <button class="btn btn-primary" onclick="document.getElementById('createUserBtn').click()">+ 创建第一个用户</button>
      </div>`;
    document.getElementById("userPagination").innerHTML = "";
    return;
  }

  const rows = users.map(u => `
    <tr>
      <td><strong>${escapeHtml(u.name)}</strong><br><span class="text-xs text-muted">${escapeHtml(u.email)}</span></td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-info' : 'badge-muted'}">${u.role === 'admin' ? '管理员' : '运营'}</span></td>
      <td><span class="${u.status === 'active' ? 'status-active' : 'status-disabled'}">${u.status === 'active' ? '正常' : '已禁用'}</span></td>
      <td class="text-xs text-muted">${u.credit_balance ?? '--'} 额度</td>
      <td class="text-xs text-muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString("zh-CN") : '从未登录'}</td>
      <td>
        <div class="flex gap-sm">
          <button class="btn btn-secondary btn-sm" data-edit-user="${u.id}">编辑</button>
          ${u.status === 'active'
            ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger);" data-disable-user="${u.id}">禁用</button>`
            : `<button class="btn btn-ghost btn-sm" style="color:var(--success);" data-enable-user="${u.id}">启用</button>`}
          <button class="btn btn-ghost btn-sm" data-reset-pwd="${u.id}">重置密码</button>
        </div>
      </td>
    </tr>
  `).join("");

  document.getElementById("userTableContainer").innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>用户</th><th>角色</th><th>状态</th><th>额度</th><th>最后登录</th><th>操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  bindUserActions(users);
}

function renderUserPagination(total) {
  const totalPages = Math.ceil(total / USER_PAGE_SIZE);
  if (totalPages <= 1) {
    document.getElementById("userPagination").innerHTML = `<span class="text-xs text-muted">共 ${total} 个用户</span>`;
    return;
  }

  let pagesHtml = "";
  for (let i = 1; i <= totalPages; i++) {
    pagesHtml += `<button class="${i === userPage ? 'active' : ''}" data-user-page="${i}">${i}</button>`;
  }

  document.getElementById("userPagination").innerHTML = `
    <span class="text-xs text-muted">共 ${total} 个用户 · 第 ${userPage}/${totalPages} 页</span>
    <div class="pagination">
      <button data-user-page="${userPage - 1}" ${userPage <= 1 ? 'disabled' : ''}>&#9666;</button>
      ${pagesHtml}
      <button data-user-page="${userPage + 1}" ${userPage >= totalPages ? 'disabled' : ''}>&#9656;</button>
    </div>`;

  document.querySelectorAll("[data-user-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = parseInt(btn.dataset.userPage);
      if (p >= 1 && p <= totalPages) {
        userPage = p;
        loadUsers(document.getElementById("userSearchInput").value.trim() || null);
      }
    });
  });
}

function bindUserActions(users) {
  $$("[data-edit-user]").forEach(btn => {
    btn.addEventListener("click", () => {
      const user = users.find(u => u.id === btn.dataset.editUser);
      if (user) openUserFormModal(user);
    });
  });

  $$("[data-disable-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const user = users.find(u => u.id === btn.dataset.disableUser);
      if (!user) return;
      if (!(await showConfirm(`禁用用户「${user.name}」`, "禁用后该用户将无法登录和使用系统。", "确认禁用", true))) return;
      try {
        await api(`/v1/admin/users/${encodeURIComponent(user.id)}`, {
          method: "PUT",
          body: JSON.stringify({ status: "disabled" })
        });
        toast("用户已禁用");
        loadUsers(document.getElementById("userSearchInput").value.trim() || null);
      } catch (err) { toast(`操作失败：${err.message}`); }
    });
  });

  $$("[data-enable-user]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const user = users.find(u => u.id === btn.dataset.enableUser);
      if (!user) return;
      try {
        await api(`/v1/admin/users/${encodeURIComponent(user.id)}`, {
          method: "PUT",
          body: JSON.stringify({ status: "active" })
        });
        toast("用户已启用");
        loadUsers(document.getElementById("userSearchInput").value.trim() || null);
      } catch (err) { toast(`操作失败：${err.message}`); }
    });
  });

  $$("[data-reset-pwd]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const user = users.find(u => u.id === btn.dataset.resetPwd);
      if (!user) return;
      if (!(await showConfirm(`重置用户「${user.name}」的密码`, "重置后该用户所有设备的活跃会话将被清除，新密码仅展示一次。", "确认重置", true))) return;
      try {
        const result = await api(`/v1/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: "POST" });
        showPasswordResult(user.name, result.password);
      } catch (err) { toast(`操作失败：${err.message}`); }
    });
  });
}

function showPasswordResult(name, password) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.5);backdrop-filter:blur(4px);";
  overlay.innerHTML = `
    <div style="background:var(--surface);padding:var(--space-xl);border-radius:var(--radius-lg);box-shadow:var(--shadow-xl);text-align:center;max-width:420px;width:92vw;">
      <h3 style="margin-bottom:var(--space-sm);">密码已重置</h3>
      <p class="text-sm text-muted">用户：${escapeHtml(name)}</p>
      <div style="background:var(--gray-100);padding:var(--space-md);border-radius:var(--radius-sm);margin:var(--space-md) 0;display:flex;align-items:center;justify-content:center;gap:var(--space-sm);">
        <span id="pwdDisplay" style="font-family:monospace;font-size:18px;user-select:none;letter-spacing:2px;">${password.length > 4 ? escapeHtml(password.slice(0, 4)) + '●'.repeat(Math.min(password.length - 4, 8)) : '●'.repeat(password.length)}</span>
        <button id="pwdToggleBtn" class="btn btn-ghost btn-sm" style="font-size:16px;padding:2px 6px;" title="显示/隐藏">&#128065;</button>
      </div>
      <div class="flex gap-sm" style="justify-content:center;margin-bottom:var(--space-md);">
        <button id="pwdCopyBtn" class="btn btn-secondary btn-sm">&#128203; 一键复制</button>
        <span id="pwdCopyFeedback" class="text-xs" style="display:none;color:var(--success);align-self:center;">&#10003; 已复制</span>
      </div>
      <p class="text-xs" style="color:var(--danger);margin-bottom:var(--space-lg);">&#9888;&#65039; 此密码仅展示一次，关闭后将无法找回</p>
      <button class="btn btn-primary close-pwd-overlay" style="min-width:140px;">确认已保存</button>
    </div>`;
  document.body.appendChild(overlay);

  const maskPassword = (pwd) => pwd.length > 4 ? pwd.slice(0, 4) + '●'.repeat(Math.min(pwd.length - 4, 8)) : '●'.repeat(pwd.length);
  let pwdVisible = false;
  overlay.querySelector("#pwdDisplay").textContent = maskPassword(password);
  overlay.querySelector("#pwdToggleBtn").addEventListener("click", () => {
    pwdVisible = !pwdVisible;
    overlay.querySelector("#pwdDisplay").textContent = pwdVisible ? password : maskPassword(password);
    overlay.querySelector("#pwdToggleBtn").innerHTML = pwdVisible ? '&#128064;' : '&#128065;';
  });
  overlay.querySelector("#pwdCopyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(password);
      overlay.querySelector("#pwdCopyBtn").style.display = "none";
      overlay.querySelector("#pwdCopyFeedback").style.display = "";
    } catch {
      toast("复制失败，请手动选择复制");
    }
  });
  const closeFn = () => overlay.remove();
  overlay.querySelector(".close-pwd-overlay").addEventListener("click", closeFn);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
}

// ── User form modal ──
function openUserFormModal(user) {
  const modal = document.getElementById("userFormModal");
  document.getElementById("userFormEditId").value = user ? user.id : "";
  document.getElementById("userFormName").value = user ? user.name : "";
  document.getElementById("userFormEmail").value = user ? user.email : "";
  document.getElementById("userFormRole").value = user ? user.role : "operator";
  document.getElementById("userFormPassword").value = "";
  document.getElementById("userFormPasswordSection").style.display = user ? "none" : "";
  document.getElementById("userFormTitle").textContent = user ? "编辑用户" : "新建用户";
  document.getElementById("userFormCreatedPassword").classList.add("hidden");
  document.getElementById("userFormError").classList.add("hidden");
  document.getElementById("userFormSubmitBtn").textContent = "保存";
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
}

function closeUserFormModal() {
  const modal = document.getElementById("userFormModal");
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

async function handleUserFormSubmit(e) {
  e.preventDefault();
  const editId = document.getElementById("userFormEditId").value;
  const name = document.getElementById("userFormName").value.trim();
  const email = document.getElementById("userFormEmail").value.trim();
  const role = document.getElementById("userFormRole").value;
  const password = document.getElementById("userFormPassword").value.trim();

  if (!name || !email) {
    document.getElementById("userFormError").textContent = "姓名和邮箱不能为空";
    document.getElementById("userFormError").classList.remove("hidden");
    return;
  }

  const btn = document.getElementById("userFormSubmitBtn");
  btn.disabled = true;
  btn.classList.add("loading");

  try {
    if (editId) {
      await api(`/v1/admin/users/${encodeURIComponent(editId)}`, {
        method: "PUT",
        body: JSON.stringify({ name, email, role })
      });
      toast("用户已更新");
      closeUserFormModal();
      loadUsers(document.getElementById("userSearchInput").value.trim() || null);
    } else {
      const result = await api("/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ name, email, role, password: password || undefined })
      });
      if (result.password) {
        const pwd = result.password;
        const masked = pwd.length > 4 ? escapeHtml(pwd.slice(0, 4)) + '●'.repeat(Math.min(pwd.length - 4, 8)) : '●'.repeat(pwd.length);
        document.getElementById("userFormCreatedPassword").innerHTML =
          `<strong>用户已创建</strong>
          <div style="background:var(--gray-100);padding:var(--space-sm) var(--space-md);border-radius:var(--radius-sm);margin-top:var(--space-sm);display:flex;align-items:center;justify-content:space-between;">
            <span id="createPwdDisplay" style="font-family:monospace;font-size:16px;letter-spacing:2px;">${masked}</span>
            <button id="createPwdToggle" class="btn btn-ghost btn-sm" style="font-size:16px;padding:2px 6px;" title="显示/隐藏">&#128065;</button>
          </div>
          <button id="createPwdCopy" class="btn btn-secondary btn-sm" style="margin-top:var(--space-sm);">&#128203; 一键复制</button>
          <span id="createPwdCopied" class="text-xs" style="display:none;color:var(--success);margin-left:var(--space-sm);">&#10003; 已复制</span>
          <p class="text-xs" style="color:var(--danger);margin-top:var(--space-sm);">&#9888;&#65039; 此密码仅展示一次，关闭弹窗后将无法找回</p>`;
        document.getElementById("userFormCreatedPassword").classList.remove("hidden");
        let pwdVisible = false;
        document.getElementById("createPwdToggle").addEventListener("click", () => {
          pwdVisible = !pwdVisible;
          document.getElementById("createPwdDisplay").textContent = pwdVisible ? pwd : masked;
          document.getElementById("createPwdToggle").innerHTML = pwdVisible ? '&#128064;' : '&#128065;';
        });
        document.getElementById("createPwdCopy").addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(pwd);
            document.getElementById("createPwdCopy").style.display = "none";
            document.getElementById("createPwdCopied").style.display = "";
          } catch { toast("复制失败，请手动选择复制"); }
        });
      }
      document.getElementById("userFormPasswordSection").style.display = "none";
      document.getElementById("userFormTitle").textContent = "用户创建成功";
      document.getElementById("userFormSubmitBtn").textContent = "确认已保存";
      btn.disabled = false;
      btn.classList.remove("loading");
      loadUsers(document.getElementById("userSearchInput").value.trim() || null);
      return;
    }
  } catch (err) {
    document.getElementById("userFormError").textContent = err.message;
    document.getElementById("userFormError").classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

// ── Audit log ──
let auditPage = 1;
const AUDIT_PAGE_SIZE = 20;
let userMap = {};

const ACTION_LABELS = {
  "user_created": "创建用户",
  "user_updated": "编辑用户",
  "user_disabled": "禁用用户",
  "user_enabled": "启用用户",
  "user_password_reset": "重置密码",
  "user_deleted": "删除用户",
  "login": "登录",
  "logout": "退出登录",
  "token_refresh": "刷新令牌",
  "change_password": "修改密码"
};

function resolveUserName(id) {
  if (!id) return "--";
  if (userMap[id]) return userMap[id];
  return String(id).slice(0, 12) + "...";
}

function translateAction(action) {
  return ACTION_LABELS[action] || action || "--";
}

async function refreshUserMap() {
  try {
    const data = await api("/v1/admin/users?page=1&page_size=200");
    const users = data.users || data;
    users.forEach(u => { userMap[u.id] = u.name; });
  } catch { /* non-critical */ }
}

async function loadAuditLogs() {
  const container = document.getElementById("auditTableContainer");
  container.innerHTML = '<div class="skeleton-table">' + Array(6).fill('<div class="skeleton-row"></div>').join("") + '</div>';

  try {
    await refreshUserMap();
    const data = await api(`/v1/admin/audit-logs?page=${auditPage}&page_size=${AUDIT_PAGE_SIZE}`);
    const logs = data.logs || data;
    renderAuditTable(logs);
    renderAuditPagination(data.total || logs.length);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger">加载失败：${err.message}</div>`;
  }
}

function renderAuditTable(logs) {
  if (!logs || !logs.length) {
    document.getElementById("auditTableContainer").innerHTML = '<div style="padding:var(--space-xl);text-align:center;color:var(--gray-500);"><div style="font-size:32px;margin-bottom:var(--space-sm);">📋</div><strong style="display:block;">暂无操作日志</strong><p class="text-xs text-muted">系统操作记录将在此处显示</p></div>';
    document.getElementById("auditPagination").innerHTML = "";
    return;
  }

  const rows = logs.map(log => `
    <tr>
      <td class="text-xs text-muted">${escapeHtml((log.id || '').slice(0, 16))}</td>
      <td><strong>${escapeHtml(translateAction(log.action))}</strong></td>
      <td class="text-xs text-muted">${escapeHtml(resolveUserName(log.target_user_id))}</td>
      <td class="text-xs text-muted">${escapeHtml(resolveUserName(log.admin_user_id))}</td>
      <td class="text-xs text-muted">${log.created_at ? new Date(log.created_at).toLocaleString("zh-CN") : ''}</td>
      <td>${log.detail ? `<button class="btn btn-ghost btn-sm" data-audit-detail="${escapeHtml(JSON.stringify(log.detail))}">查看</button>` : '<span class="text-xs text-muted">--</span>'}</td>
    </tr>
  `).join("");

  document.getElementById("auditTableContainer").innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>ID</th><th>操作</th><th>目标用户</th><th>操作人</th><th>时间</th><th>详情</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $$("[data-audit-detail]").forEach(btn => {
    btn.addEventListener("click", () => {
      try { alert(JSON.stringify(JSON.parse(btn.dataset.auditDetail), null, 2)); }
      catch { alert(btn.dataset.auditDetail); }
    });
  });
}

function renderAuditPagination(total) {
  const totalPages = Math.ceil(total / AUDIT_PAGE_SIZE);
  if (totalPages <= 1) {
    document.getElementById("auditPagination").innerHTML = `<span class="text-xs text-muted">共 ${total} 条记录</span>`;
    return;
  }

  let pagesHtml = "";
  for (let i = 1; i <= totalPages; i++) {
    pagesHtml += `<button class="${i === auditPage ? 'active' : ''}" data-audit-page="${i}">${i}</button>`;
  }

  document.getElementById("auditPagination").innerHTML = `
    <span class="text-xs text-muted">共 ${total} 条 · 第 ${auditPage}/${totalPages} 页</span>
    <div class="pagination">
      <button data-audit-page="${auditPage - 1}" ${auditPage <= 1 ? 'disabled' : ''}>&#9666;</button>
      ${pagesHtml}
      <button data-audit-page="${auditPage + 1}" ${auditPage >= totalPages ? 'disabled' : ''}>&#9656;</button>
    </div>`;

  document.querySelectorAll("[data-audit-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = parseInt(btn.dataset.auditPage);
      if (p >= 1 && p <= totalPages) {
        auditPage = p;
        loadAuditLogs();
      }
    });
  });
}

// ── Custom confirm modal ──
function showConfirm(title, message, confirmLabel, danger) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:400;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,0.5);backdrop-filter:blur(4px);";
    overlay.innerHTML = `
      <div style="background:var(--surface);padding:var(--space-xl);border-radius:var(--radius-lg);box-shadow:var(--shadow-xl);max-width:420px;width:92vw;">
        <h3 style="margin-bottom:var(--space-sm);">${escapeHtml(title)}</h3>
        <p class="text-sm text-muted" style="margin-bottom:var(--space-lg);">${escapeHtml(message)}</p>
        <div class="flex gap-sm" style="justify-content:flex-end;">
          <button class="btn btn-secondary" data-confirm-cancel>取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-ok>${escapeHtml(confirmLabel || '确认')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector("[data-confirm-ok]").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.querySelector("[data-confirm-cancel]").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// ── Tab switching ──
function switchAdminTab(tabName) {
  $$(".admin-nav-item").forEach(item => item.classList.remove("active"));
  $$(".admin-tab").forEach(tab => tab.classList.remove("active"));

  const navItem = document.querySelector(`[data-admin-tab="${tabName}"]`);
  if (navItem) navItem.classList.add("active");

  const tabEl = document.getElementById(
    tabName === "users" ? "adminUsersTab" : "adminAuditTab"
  );
  if (tabEl) tabEl.classList.add("active");

  const pageTitle = document.getElementById("adminPageTitle");
  if (pageTitle) pageTitle.textContent = tabName === "users" ? "用户管理" : "操作日志";

  if (tabName === "users") { loadUsers(); updateUserCount(); }
  if (tabName === "audit") loadAuditLogs();
}

// ── User count ──
async function updateUserCount() {
  try {
    const data = await api("/v1/admin/users?page=1&page_size=1");
    const el = document.getElementById("adminUserCount");
    if (el) el.textContent = `共 ${data.total || 0} 个用户`;
  } catch { /* non-critical */ }
}

// ── Init ──
async function init() {
  document.getElementById("adminLoginForm").addEventListener("submit", handleAdminLogin);
  document.getElementById("adminLogoutBtn").addEventListener("click", handleAdminLogout);
  document.getElementById("identityConfirmBtn").addEventListener("click", enterAdminConsole);
  document.getElementById("identityNotMeBtn").addEventListener("click", handleAdminLogout);

  // Remember me hint toggle
  const rememberCb = document.getElementById("adminLoginRemember");
  const rememberHint = document.getElementById("adminLoginRememberHint");
  if (rememberCb && rememberHint) {
    const updateHint = () => {
      rememberHint.textContent = rememberCb.checked ? "30 天内无需重新登录" : "7 天内保持登录";
      rememberHint.style.color = rememberCb.checked ? "var(--success)" : "";
      rememberHint.style.fontWeight = rememberCb.checked ? "500" : "";
    };
    rememberCb.addEventListener("change", updateHint);
  }

  document.getElementById("createUserBtn").addEventListener("click", () => openUserFormModal(null));
  document.getElementById("userForm").addEventListener("submit", handleUserFormSubmit);
  document.querySelectorAll("[data-close-user-modal]").forEach(el => {
    el.addEventListener("click", closeUserFormModal);
  });

  document.getElementById("userSearchInput").addEventListener("input", () => {
    userPage = 1;
    loadUsers(document.getElementById("userSearchInput").value.trim() || null);
  });

  $$(".admin-nav-item").forEach(item => {
    item.addEventListener("click", () => switchAdminTab(item.dataset.adminTab));
  });

  // Auto-login: try cached access token first, fall back to refresh
  const stored = loadStoredToken();
  if (stored.refreshToken) {
    auth.refreshToken = stored.refreshToken;
// Always go through refresh for security (access token kept in memory only)
    try {
      auth.accessToken = await refreshAccessToken();
      const user = await api("/v1/auth/me");
      if (user.role !== "admin") {
        clearTokens();
        window.location.href = `http://${window.location.hostname}:3000`;
        return;
      }
      auth.user = user;
      saveTokens(auth.accessToken, auth.refreshToken, !!localStorage.getItem("admin.rememberMe"));
      showAdminConsole();
      switchAdminTab("users");
      return;
    } catch (err) {
      console.error("admin auto-login failed:", err);
      clearTokens();
    }
  }
  showAdminLogin();
}

init().catch(err => {
  const el = document.getElementById("adminLoginError");
  if (el) { el.textContent = err.message; el.classList.remove("hidden"); }
});
