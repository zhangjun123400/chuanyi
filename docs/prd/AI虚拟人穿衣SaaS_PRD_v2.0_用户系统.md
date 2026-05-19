# 产品需求文档 PRD

## AI虚拟人穿衣 SaaS v2.0 · 用户系统（Part 1）

**多租户认证与授权体系 + 独立管理员后台**

| 字段 | 内容 |
|------|------|
| 版本 | v2.0 Part 1 — 用户系统 |
| 基线 | v1.0.2 定稿版 |
| 负责人 | 多灵 / AI Agent 产品经理 |
| 日期 | 2026-05-18 |
| 定位 | 在 v1.0.2 单任务商用闭环基础上，构建多租户用户认证与授权体系，支持管理员通过独立后台管理用户账号。本 PRD 为 v2.0 的第一阶段，v2.0 完整范围包含用户系统（本文档）+ 批量商用生产工作台（单独 PRD） |
| 范围 | JWT 认证（登录/登出/令牌刷新/修改密码）、基于角色的访问控制（admin/operator）、独立管理员后台（用户 CRUD + 搜索分页 + 操作审计）、多租户数据隔离、前端登录页、记住我、空态/Loading/错误态、登录频率限制 |

---

## 1. 背景与问题

### 1.1 当前状态

v1.0.2 定稿版是单租户、单用户、零认证的原型系统：
- 所有用户 ID（`user-demo`）和租户 ID（`tenant-demo`）硬编码在后端路由中
- 不存在登录、密码、会话或令牌机制
- 前端直接调用 API，不携带任何身份凭证
- 任何知晓后端地址的人都可以无限制访问所有数据和操作

### 1.2 需解决的问题

| 问题 | 影响 | 严重程度 |
|------|------|---------|
| 无用户认证 | 任何人都可访问 API，无权限控制 | P0 |
| 无用户隔离 | 所有操作共用一个数据空间 | P0 |
| 无管理员工具 | 无法创建/管理用户账号 | P0 |
| 硬编码用户 | 无法扩展为多用户 SaaS | P0 |

### 1.3 v2.0 完整范围与本 PRD 边界

v2.0 完整版本由两部分组成：

| 部分 | 内容 | 文档 |
|------|------|------|
| Part 1（本文档） | 用户系统：认证、授权、多租户隔离、管理员后台 | 本文档 |
| Part 2（后续） | 批量商用生产工作台：项目/SKU管理、批量上传、批量生成、参数模板、生产看板 | 单独 PRD |

用户系统是 v2.0 的基础设施——批量生产工作台依赖多用户体系才能上线。

---

## 2. 产品目标

### 2.1 v2.0 用户系统目标

1. **用户可登录**：操作员通过邮箱+密码登录主工作台，支持「记住我」
2. **管理员可管理用户**：通过独立后台创建/编辑/禁用用户、重置密码，支持搜索和分页
3. **用户可自行修改密码**：首次登录后可在主应用内修改密码
4. **数据隔离**：每个用户只能看到和操作自己的数据，明确定义租户级/用户级数据边界
5. **操作可追溯**：管理员后台记录所有用户管理操作日志
6. **安全认证**：JWT access/refresh token 双令牌机制，令牌过期自动刷新，登录频率限制
7. **首次引入依赖**：jsonwebtoken + bcryptjs，保持最小依赖原则

### 2.2 不做的事

- 不做用户自助注册（由管理员创建账号）
- 不做 OAuth/SSO 第三方登录
- 不做细粒度权限（RBAC 仅 admin/operator 两级）
- 不做租户自助管理
- 不做密码强度策略、MFA（留到 v2.0.1）
- 不做忘记密码/自助找回（当前由管理员重置，留到 v2.0.1）

---

## 3. 用户角色

| 角色 | 标识 | 权限范围 |
|------|------|---------|
| 管理员 (admin) | role: "admin" | 登录主工作台 + 登录独立后台 + 管理所有用户（创建/编辑/禁用/重置密码） + 查看所有用户数据 |
| 操作员 (operator) | role: "operator" | 仅登录主工作台 + 仅操作自己的数据（创建任务、查看结果、管理模特和服装） |

**权限矩阵：**

| 功能 | operator | admin |
|------|----------|-------|
| 登录主工作台 (3000) | ✓ | ✓ |
| 登录管理员后台 (3001) | ✗ | ✓ |
| 创建试衣任务 | ✓（自己） | ✓（自己） |
| 查看/下载自己的结果 | ✓ | ✓ |
| 管理自己的模特/服装 | ✓ | ✓ |
| 修改自己的密码 | ✓ | ✓ |
| 查看所有用户列表 | ✗ | ✓ |
| 创建/编辑/禁用用户 | ✗ | ✓ |
| 重置其他用户密码 | ✗ | ✓ |
| 查看管理员操作日志 | ✗ | ✓ |
| 查看系统能力/统计 | ✓ | ✓ |

---

## 4. 认证流程

### 4.1 登录流程

```
用户打开主应用 (localhost:3000)
  → 检查 localStorage 是否有 access_token
    → 有：调用 GET /v1/auth/me 验证令牌有效性
      → 有效：进入主应用工作台
      → 过期：尝试用 refresh_token 刷新
        → 刷新成功：更新令牌，进入主应用
        → 刷新失败：清除令牌，显示登录页
    → 无：显示登录页

登录页 → 输入邮箱 + 密码 + [ ]记住我 → POST /v1/auth/login
  → 成功：存储 access_token + refresh_token + user 到 localStorage → 进入主应用
  → 失败：显示错误提示（账号不存在/密码错误/账号已禁用）
```

**记住我交互：**

| 状态 | 提示文案 | refresh_token 有效期 |
|------|---------|---------------------|
| 未勾选 | 「7 天内保持登录」 | 7 天 |
| 勾选 | 「30 天内无需重新登录」 | 30 天 |

登录成功后，在主应用侧边栏用户区底部显示登录有效期提示，例如「登录有效期至 6月17日」，让用户明确感知剩余时间。

### 4.2 令牌刷新流程

**正常刷新：**
```
api() 调用返回 401
  → 自动调用 POST /v1/auth/refresh { refresh_token }
    → 成功：更新 localStorage 中的令牌，重试原请求
    → 失败：清除所有令牌，跳回登录页
```

**并发刷新保护（leader-follower 模式）：**

当多个请求同时因 access token 过期触发刷新时，前端确保只有一个请求执行实际的 refresh 调用，其他请求等待结果：

```
请求A返回401 → 检查是否已有进行中的refresh
  → 无：发起refresh，将返回的 Promise 缓存到全局 state.refreshPromise
  → 有：等待 state.refreshPromise，拿到结果后各自重试

refresh 完成（成功或失败）→ 清除 state.refreshPromise
```

这样避免多个请求同时使用同一个 refresh token 导致后续请求因 token 已被吊销而失败。

### 4.3 登出流程

```
用户点击登出 → POST /v1/auth/logout（吊销 refresh_token）
  → 清除 localStorage 所有令牌
  → 跳回登录页
```

### 4.4 管理员后台登录

**独立登录页：**
```
管理员打开后台 (localhost:3001)
  → 检查 localStorage 是否有 access_token
    → 有：调用 GET /v1/auth/me 验证令牌 + 检查 role === "admin"
      → 是 admin：显示身份确认过渡页（见下方） → 自动进入管理后台
      → 非 admin：提示「无权限访问」，跳回后台登录页
      → 令牌过期：尝试 refresh → 成功重新校验角色 → 失败则显示登录页
    → 无：显示后台登录页

后台登录页 → 输入邮箱 + 密码 → POST /v1/auth/login
  → 后端在响应中返回 user.role
  → 前端检查 role !== "admin" → 提示「此账号非管理员，无法登录后台」
  → role === "admin" → 存储令牌，进入管理后台
```

**免密身份确认过渡页：**

管理员在主应用已登录后打开后台（共享 localStorage），不直接进入，而是展示约 2 秒的身份确认过渡页：

```
┌──────────────────────────────────┐
│                                  │
│        TryOn Studio             │
│        管理后台                  │
│                                  │
│   检测到已登录的管理员账号：      │
│   admin@tryonstudio.local        │
│                                  │
│   正在进入管理后台...            │
│                                  │
│   [ 这不是我，退出登录 ]         │
│                                  │
└──────────────────────────────────┘
```

- 2 秒内用户无操作 → 自动进入管理后台
- 点击「这不是我，退出登录」→ 清除所有令牌，跳回后台登录页
- 这比静默直接进入更透明、更安全

### 4.5 并发登录策略

| 策略 | 说明 |
|------|------|
| 多设备登录 | 允许。同一账号可在多个设备/浏览器同时登录 |
| 令牌独立性 | 每个登录会话独立持有自己的 access_token + refresh_token 对 |
| 登出影响范围 | 登出操作仅吊销当前会话的 refresh_token，不影响其他设备 |
| 修改密码 | 修改密码后吊销该用户所有活跃 refresh_token，所有设备需重新登录 |
| 管理员禁用用户 | 禁用后吊销该用户所有 refresh_token，所有设备立即登出 |

### 4.6 修改密码流程

```
用户在主应用点击「修改密码」
  → 弹窗输入：旧密码 + 新密码 + 确认新密码
  → POST /v1/auth/change-password { old_password, new_password }
    → 成功：显示过渡提示页（见下方）
    → 失败：弹窗内提示「旧密码错误」
```

**修改密码成功过渡页：**

修改密码成功后不直接跳回空白登录页，而是展示过渡提示页：

```
┌──────────────────────────────────┐
│                                  │
│          ✓ 密码已修改            │
│                                  │
│   为保障账号安全，所有设备       │
│   已退出登录                    │
│                                  │
│   请使用新密码重新登录           │
│                                  │
│      3 秒后自动跳转登录页        │
│      [ 立即登录 ]               │
│                                  │
└──────────────────────────────────┘
```

- 3 秒倒计时自动跳转登录页
- 用户可点击「立即登录」提前跳转
- 避免用户误以为系统出错

---

## 5. 数据模型

### 5.1 User（扩展后）

```json
{
  "id": "user_a1b2c3d4e5f6g7h8",
  "tenant_id": "tenant-demo",
  "email": "admin@tryonstudio.local",
  "name": "运营管理员",
  "password_hash": "$2a$10$...",
  "role": "admin",
  "status": "active",
  "credit_balance": 1200,
  "token_version": 1,
  "last_login_at": "2026-05-18T12:00:00.000Z",
  "created_at": "2026-05-18T12:00:00.000Z",
  "updated_at": "2026-05-18T12:00:00.000Z"
}
```

**新增字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| email | string | 是 | 登录标识，租户内唯一 |
| password_hash | string | 是 | bcryptjs 哈希，自动生成 salt |
| role | string | 是 | "admin" 或 "operator" |
| status | string | 是 | "active" 或 "disabled"，禁用后无法登录且所有令牌立即失效 |
| token_version | number | 是 | 令牌版本号，修改密码/禁用时递增，JWT 中携带此版本号，验证时校验版本一致性，实现无黑名单的全局吊销 |
| last_login_at | string | 否 | 最近一次登录 ISO 时间戳 |

### 5.2 Tenant（扩展后）

```json
{
  "id": "tenant-demo",
  "name": "Demo Fashion Studio",
  "plan": "pro",
  "created_at": "2026-05-18T12:00:00.000Z",
  "updated_at": "2026-05-18T12:00:00.000Z"
}
```

新增 `created_at` 和 `updated_at` 时间戳。

### 5.3 Refresh Token 黑名单

```json
"refresh_token_blacklist": [
  {
    "jti": "abc123def456",
    "user_id": "user_a1b2c3d4",
    "expires_at": "2026-05-25T12:00:00.000Z"
  }
]
```

用于登出和令牌轮换时吊销特定 refresh token。修改密码和禁用用户时通过递增 `token_version` 实现无黑名单的全局吊销（见 5.1），无需将大量 token 加入黑名单。

**清理策略：** 每次 store 写入时，清除 `expires_at < now()` 的条目。每次 store 读取时也执行清理，确保低活跃期能回收。黑名单中 `user_id` 字段用于支持按用户批量吊销（登出和令牌轮换场景）。

### 5.4 管理员操作日志

```json
"admin_audit_logs": [
  {
    "id": "audit_a1b2c3d4e5f6g7h8",
    "tenant_id": "tenant-demo",
    "admin_user_id": "user_admin001",
    "action": "user_created",
    "target_user_id": "user_new001",
    "detail": { "email": "new@test.com", "role": "operator" },
    "created_at": "2026-05-18T12:00:00.000Z"
  }
]
```

**记录的操作类型：**

| action | 说明 |
|--------|------|
| user_created | 创建用户 |
| user_updated | 编辑用户信息（记录变更字段） |
| user_disabled | 禁用用户 |
| user_enabled | 启用用户 |
| user_password_reset | 重置用户密码 |

日志只增不删，管理员可在后台查看。

### 5.5 种子数据

系统首次初始化时自动创建默认管理员：

| 字段 | 值 |
|------|-----|
| email | admin@tryonstudio.local |
| name | 系统管理员 |
| role | admin |
| status | active |
| password | crypto.randomBytes(8).toString("hex") |

**密码交付方式：** 不打印到控制台（避免日志系统明文留存）。改为写入项目根目录 `.admin-credentials` 文件，设置文件权限 600（仅所有者可读写）。首次启动时在控制台提示文件路径：「初始管理员密码已写入 .admin-credentials，请妥善保存。首次登录后建议立即修改密码。」

### 5.6 向后兼容迁移

`ensureStoreShape()` 在每次读取 store 时自动执行，对现有用户补充缺失字段：
- email：自动生成为 `user_<id>@auto.local`
- password_hash：随机密码哈希（需通过管理员重置后才能登录）
- role：设为 `"admin"`（历史用户默认为管理员）
- status：设为 `"active"`
- token_version：设为 `1`
- last_login_at：null

### 5.7 v1.0.2 生产数据迁移归属

现有生产数据（73个任务、51个结果、74个服装资产、29个模特资产、73条额度流水、1022条事件）的归属处理：

| 数据 | 迁移策略 |
|------|---------|
| 租户数据 (tenant-demo) | 保持不变，归属原租户 |
| 历史用户 (user-demo) | 自动升级为 admin 角色，历史数据归属该用户 |
| 已有任务/结果/服装/额度流水 | user_id 保持 "user-demo"，归属升级后的管理员用户 |
| 已有系统模特 (Eva/Mia/Noah) | 系统模特，所有用户可见 |
| 已有自定义模特 (model_assets) | user_id 为 "user-demo" 的归属管理员；user_id 为空的归属管理员 |

**核心原则：历史数据全部归属升级后的管理员用户，后续新增数据按 user_id 隔离。**

### 5.8 数据所有权矩阵

明确每类数据的可见性范围：

| 数据 | 所有权级别 | 说明 |
|------|-----------|------|
| 系统模特 (Eva/Mia/Noah) | 租户级共享 | 所有用户可见，可被任何用户选为试衣模特 |
| 自定义模特 (model_assets) | 用户级私有 | 仅创建者可见和使用 |
| 服装资产 (garments) | 用户级私有 | 仅上传者可见和使用 |
| 任务 (tasks) | 用户级私有 | 仅创建者可见和操作 |
| 结果 (results) | 用户级私有 | 仅任务创建者可见和下载 |
| 额度 (credit_balance) | 用户级私有 | 每个用户独立额度账户 |
| 额度流水 (credit_logs) | 用户级私有 | 仅自己的流水记录可见 |
| 模型栈配置 (capabilities) | 租户级共享 | 由 .env 配置，所有用户看到相同模型可用性 |
| 统计数据 (/v1/stats) | 用户级私有 | 仅统计当前用户自己的数据 |
| 管理员操作日志 | 租户级共享 | 仅 admin 角色可查看 |

---

## 6. API 接口

### 6.1 认证端点（公开，无需认证）

| 方法 | 路径 | 说明 | 请求体 | 响应 |
|------|------|------|--------|------|
| POST | /v1/auth/login | 用户登录 | `{ email, password, remember_me? }` | `{ access_token, refresh_token, user }` |
| POST | /v1/auth/refresh | 刷新令牌 | `{ refresh_token }` | `{ access_token, refresh_token }` |

**login 说明：** remember_me 为 true 时，refresh_token 有效期 30 天，否则 7 天。响应中的 user 对象包含 id、tenant_id、email、name、role、credit_balance，前端依据 role 决定是否展示管理后台入口。

### 6.2 认证端点（需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /v1/auth/logout | 吊销当前会话的 refresh token |
| GET | /v1/auth/me | 获取当前用户信息（含 role，用于权限校验） |
| POST | /v1/auth/change-password | 用户自行修改密码 `{ old_password, new_password }` |

**change-password 说明：** 校验旧密码正确后更新为新密码，同时递增该用户的 `token_version`，所有设备上携带旧版本号的 token 立即失效，强制重新登录。

### 6.3 管理员端点（需 admin 角色）

| 方法 | 路径 | 说明 | 请求体 |
|------|------|------|--------|
| GET | /v1/admin/users | 列出用户（支持搜索和分页） | Query: `?search=&role=&status=&page=1&page_size=20` |
| POST | /v1/admin/users | 创建新用户 | `{ email, name, role, credit_balance? }` |
| PUT | /v1/admin/users/:id | 编辑用户信息 | `{ name?, role?, status?, credit_balance? }` |
| DELETE | /v1/admin/users/:id | 禁用用户（软删除） | - |
| POST | /v1/admin/users/:id/reset-password | 重置用户密码 | `{ new_password? }`（不传则自动生成） |
| GET | /v1/admin/audit-logs | 查看操作日志 | Query: `?page=1&page_size=50` |

**GET /v1/admin/users 参数说明：**

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| search | string | - | 模糊匹配邮箱和姓名 |
| role | string | - | 筛选角色：admin / operator |
| status | string | - | 筛选状态：active / disabled |
| page | number | 1 | 页码，从 1 开始 |
| page_size | number | 20 | 每页条数，最大 100 |

响应格式：`{ users: [...], total: 42, page: 1, page_size: 20, total_pages: 3 }`

**POST /v1/admin/users 创建响应：** 返回新用户信息 + 生成的明文密码（仅此一次展示），`{ user: {...}, password: "a3f8c2e1" }`

### 6.4 API 序列化安全规则

所有返回用户的 API 必须遵守以下序列化规则：

| 规则 | 说明 |
|------|------|
| 排除 password_hash | 任何接口不得返回 `password_hash` 字段，包括管理员接口 |
| 排除 token_version | `token_version` 仅在 JWT 载荷中携带，不在 API 响应中暴露 |
| 用户列表/详情 | 返回字段白名单：id、tenant_id、email、name、role、status、credit_balance、last_login_at、created_at、updated_at |

建议在后端封装 `serializeUser(user)` 函数，所有返回用户数据的地方统一调用，从源头杜绝敏感字段泄露。

### 6.5 已有端点变更

所有 `/v1/tryon/*`、`/v1/models/*`、`/v1/garments/*`、`/v1/credits/*`、`/v1/stats`、`/v1/assets/*`、`/v1/agent/*` 路由均需携带有效 JWT。后端从令牌中解析 user_id 和 tenant_id，不再使用硬编码值。

公开端点（无需认证）保持不变：`GET /health`、`GET /v1/system/capabilities`。

### 6.6 认证头格式

所有需认证的请求携带：
```
Authorization: Bearer <access_token>
```

### 6.7 JWT 载荷结构

```json
{
  "sub": "user_a1b2c3d4",
  "tenant_id": "tenant-demo",
  "email": "admin@tryonstudio.local",
  "role": "admin",
  "token_version": 1,
  "iat": 1700000000,
  "exp": 1700000900,
  "jti": "random_hex_16"
}
```

Refresh token 在载荷中增加 `"type": "refresh"` 字段以区分。`token_version` 与用户记录中的版本号比对，不一致则令牌无效——这实现了修改密码/禁用时的全局吊销，无需依赖黑名单。

---

## 7. 错误码体系（合并 v1.0.2 + v2.0 新增）

### 7.1 认证与授权（v2.0 新增）

| 错误码 | HTTP | 说明 |
|--------|------|------|
| AUTH_REQUIRED | 401 | 未提供认证令牌 |
| TOKEN_EXPIRED | 401 | 令牌已过期 |
| TOKEN_INVALID | 401 | 令牌无效 |
| REFRESH_TOKEN_INVALID | 401 | 刷新令牌无效或已被吊销 |
| LOGIN_RATE_LIMITED | 429 | 登录频率超限，请稍后再试 |
| FORBIDDEN | 403 | 权限不足（非管理员访问管理接口） |
| USER_DISABLED | 403 | 账号已被禁用 |
| EMAIL_ALREADY_EXISTS | 409 | 邮箱已被同一租户下其他用户使用 |
| USER_NOT_FOUND | 404 | 用户不存在 |
| CANNOT_DISABLE_SELF | 422 | 不能禁用自己的账号 |
| CANNOT_DEMOTE_LAST_ADMIN | 422 | 不能取消最后一个管理员的 admin 角色 |
| OLD_PASSWORD_WRONG | 422 | 修改密码时旧密码错误 |

### 7.2 业务错误码（v1.0.2 已有，保留不变）

| 错误码 | HTTP | 说明 |
|--------|------|------|
| INSUFFICIENT_CREDITS | 402 | 额度不足 |
| GARMENT_REFERENCE_LIMIT_EXCEEDED | 422 | 细节参考图超10张 |
| ALIYUN_TRYON_INPUT_INVALID | 422 | 百炼输入校验失败 |
| FASHN_INPUT_INVALID | 422 | 302.AI 输入校验失败 |
| PIXELCUT_TOKEN_MISSING | 422 | 未配置 Pixelcut Key |
| THREE_O_TWO_TOKEN_MISSING | 422 | 未配置 302.AI Key |
| PIXAZO_TOKEN_MISSING | 422 | 未配置 Pixazo Key |
| REPLICATE_TOKEN_MISSING | 422 | 未配置 Replicate Token |
| GPT_IMAGE_TRYON_DISABLED | 422 | GPT-Image 试衣未启用 |
| MODEL_IN_USE | 409 | 模特有进行中任务 |
| LAST_MODEL_NOT_REMOVABLE | 409 | 最后一个模特不可删 |
| TASK_NOT_CANCELLABLE | 409 | 任务已结束不可取消 |
| RESULT_NOT_DOWNLOADABLE | 409 | 未达下载门槛 |
| NOT_FOUND | 404 | 资源不存在 |
| PROVIDER_ERROR | 502 | 模型供应商错误 |
| CONTENT_REJECTED | 502 | 内容审核拦截 |

---

## 8. 前端设计

### 8.1 主应用登录页（localhost:3000）

**未登录状态：** 显示登录卡片，隐藏主应用界面。

**登录卡片布局：**
```
┌──────────────────────────────────┐
│                                  │
│        TryOn Studio             │
│        AI虚拟人穿衣              │
│                                  │
│  ┌────────────────────────────┐  │
│  │  邮箱                       │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━ │  │
│  │  密码                       │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━ │  │
│  │                            │  │
│  │  [x] 记住我 — 30天内无需    │  │
│  │       重新登录              │  │
│  │                            │  │
│  │  [      登  录      ]      │  │
│  │                            │  │
│  │  错误提示区域               │  │
│  └────────────────────────────┘  │
│                                  │
└──────────────────────────────────┘
```

**交互规则：**
- 邮箱和密码任一为空时，登录按钮 disabled
- 「记住我」默认不勾选，勾选时提示「30天内无需重新登录」，未勾选时提示「7天内保持登录」
- 登录进行中按钮显示 loading 态
- 登录失败在卡片内显示红色错误提示
- 登录成功过渡到主应用（登录卡片淡出，应用壳淡入）

### 8.2 主应用变更

**侧边栏底部用户区（含登录有效期）：**
```
┌────────────────────┐
│                    │
│  (导航项...)       │
│                    │
├────────────────────┤
│ 👤 运营管理员      │
│    admin · 额度1200 │
│                    │
│ 有效期至 6月17日    │
│ [修改密码] [登出]  │
└────────────────────┘
```

**修改密码弹窗：**
```
┌──────────────────────────────┐
│  修改密码                     │
│                              │
│  旧密码  ━━━━━━━━━━━━━━━━━  │
│  新密码  ━━━━━━━━━━━━━━━━━  │
│  确认密码 ━━━━━━━━━━━━━━━━━  │
│                              │
│  新密码长度不少于6位          │
│                              │
│  [取消]  [确认修改]          │
└──────────────────────────────┘
```

**修改密码成功过渡页（见 4.6 节设计）。**

**前端核心改造：**
- `api()` 函数自动注入 Authorization header
- `api()` 函数拦截 401 → leader-follower 模式自动 refresh → 失败则跳回登录页
- 侧边栏底部增加用户信息区域、登录有效期提示、登出/修改密码入口

### 8.3 管理员后台登录页（localhost:3001）

管理员后台有独立的登录页面，风格与主应用登录页一致但标注「管理后台」。

```
┌──────────────────────────────────┐
│                                  │
│        TryOn Studio             │
│        管理后台                  │
│                                  │
│  ┌────────────────────────────┐  │
│  │  管理员邮箱                 │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━ │  │
│  │  密码                       │  │
│  │  ━━━━━━━━━━━━━━━━━━━━━━━━ │  │
│  │                            │  │
│  │  [      登  录      ]      │  │
│  │                            │  │
│  │  错误提示区域               │  │
│  └────────────────────────────┘  │
│                                  │
│  仅限管理员账号登录               │
└──────────────────────────────────┘
```

**鉴权逻辑：**
- 后台登录同样调用 POST /v1/auth/login
- 后端返回 user.role，前端检查若非 admin 则拒绝进入，提示「此账号非管理员」
- 如果主应用已登录（同一浏览器 localStorage 共享），且 role=admin，展示身份确认过渡页（见 4.4 节），2秒后自动进入
- 后台每个 API 调用独立验证 admin 权限，不依赖前端判断

### 8.4 管理员后台主界面（localhost:3001）

**采用水平 Tab 结构，切换「用户管理」和「操作日志」两个独立视图：**

```
┌──────────────────────────────────────────────┐
│  TryOn Studio · 管理后台                      │
│                                              │
│  管理员: xxx@xxx.com  [登出]                  │
├──────────────────────────────────────────────┤
│  [ 用户管理 ]  [ 操作日志 ]                   │
├──────────────────────────────────────────────┤
│                                              │
│  （当前 Tab 内容区域，独立滚动）              │
│                                              │
└──────────────────────────────────────────────┘
```

**Tab 说明：** 用户管理高频使用，操作日志低频查阅。Tab 切换时各自保留筛选/分页状态，不互相影响。

**用户管理 Tab：**

```
┌────────────────────────────────────────┐
│ [+ 新增用户]      🔍 [搜索邮箱/姓名...] │
│  角色: [全部▾]  状态: [全部▾]          │
│                                        │
│ 邮箱 | 姓名 | 角色 | 状态 | 额度 | 操作 │
│ ──────────────────────────────────────│
│ a@b  | 张三 | admin | 🟢启用 | 1200  │✎🔑⏻│
│ d@e  | 李四 | operator| 🟢启用 | 500  │✎🔑⏻│
│ g@h  | 王五 | operator| 🔴禁用 | 0    │✎🔑⏻│
│                                        │
│          第 1/3 页  < 1 2 3 >          │
└────────────────────────────────────────┘
```

**搜索与分页：**
- 搜索框支持按邮箱和姓名模糊搜索，输入 2 个字符后触发（防抖 300ms）
- 角色下拉筛选：全部 / admin / operator
- 状态下拉筛选：全部 / 启用 / 禁用
- 筛选条件变化时自动重新加载第一页
- 分页控件：显示总条数、总页数、当前页码、上下页按钮

**新增用户弹窗：**
- 邮箱（必填）
- 姓名（必填）
- 角色（admin / operator 下拉选择，默认 operator）
- 初始额度（数字，默认 500）
- 密码：自动生成随机 8 位密码，创建成功后弹窗展示
- 二次确认弹窗：提示「确认创建此用户？」

**创建成功后密码展示弹窗（安全体验设计）：**

```
┌──────────────────────────────────────┐
│  用户创建成功                        │
│                                      │
│  新用户：new_user@tryonstudio.local  │
│                                      │
│  初始密码：                          │
│  ┌──────────────────────────┐        │
│  │  a3f8••••      [👁 查看] │        │
│  └──────────────────────────┘        │
│  [ 📋 一键复制 ]                     │
│                                      │
│  ⚠️ 此密码仅展示一次，关闭弹窗后    │
│  将无法找回。请妥善保存并交给用户    │
│                                      │
│              [ 确认已保存 ]          │
└──────────────────────────────────────┘
```

- 密码默认脱敏显示（`a3f8••••`），旁边有 👁 点击切换查看完整密码
- 「📋 一键复制」按钮，复制成功后短暂变为绿色「✓ 已复制」
- 底部红色警告文案提示仅展示一次
- 按钮文案用「确认已保存」而非「关闭」，让管理员有明确的确认动作

**编辑用户弹窗：**
- 可修改：姓名、角色、状态（启用/禁用）、额度
- 不可修改：邮箱（展示但置灰）
- 变更角色为 operator 时，如果是租户最后一个 admin，阻止并提示

**操作按钮：**
- ✎ 编辑
- 🔑 重置密码（确认后弹窗展示新随机密码，密码展示与创建时相同的安全交互）
- ⏻ 禁用/启用（toggle，禁用时二次确认：「禁用后该用户将无法登录，确认？」）

**操作日志 Tab：**

```
┌────────────────────────────────────────┐
│  操作日志                              │
│                                        │
│ 时间 | 管理员 | 操作 | 目标用户 | 详情  │
│ ──────────────────────────────────────│
│ 12:00| admin  | 创建 | new@t.com| opera│
│ 11:30| admin  | 禁用 | old@t.com| -    │
│ 09:15| admin  | 重置密码| user@t| -    │
│                                        │
│          第 1/5 页  < 1 2 3 4 5 >     │
└────────────────────────────────────────┘
```

### 8.5 空态、Loading 态、错误态设计

以下边界状态在真实使用中必然出现，需在 UI 设计中提供明确参照。

#### 8.5.1 主应用登录页

| 状态 | 设计 |
|------|------|
| 登录按钮 Loading | 按钮文案变为「登录中...」，按钮置灰 + spinner |
| 登录失败 | 卡片内红色提示条：「账号不存在」「密码错误」「账号已禁用，请联系管理员」 |
| 网络错误 | 卡片内红色提示条：「网络连接失败，请检查网络后重试」 |
| 登录频率限制 | 卡片内黄色提示条：「登录尝试次数过多，请 60 秒后再试」 |

#### 8.5.2 管理员后台 — 用户管理 Tab

| 状态 | 设计 |
|------|------|
| 首次加载中 | 表格区域显示骨架屏（3 行灰色占位条 + 闪烁动画） |
| 列表为空（新租户） | 居中空态插图 + 「暂无用户」+ 「创建第一个用户」引导按钮 |
| 搜索无结果 | 居中提示：「未找到匹配「xxx」的用户」+ 「清除搜索」链接 |
| 分页切换加载 | 表格行短暂半透明 + 底部页码保留（不闪烁） |
| 创建/编辑提交中 | 确认按钮显示 spinner + 「创建中...」，禁止重复点击 |
| 操作失败 | 顶部红色 Toast：「操作失败：xxx」，3 秒自动消失 |
| 删除/禁用确认 | 二次确认弹窗：标题 + 警告文案 + [取消] [确认禁用] |

#### 8.5.3 管理员后台 — 操作日志 Tab

| 状态 | 设计 |
|------|------|
| 首次加载中 | 表格区域骨架屏 |
| 日志为空 | 居中空态：「暂无操作记录」 |

#### 8.5.4 后台登录页

| 状态 | 设计 |
|------|------|
| 登录按钮 Loading | 「验证中...」+ spinner |
| 非管理员登录 | 红色提示：「此账号非管理员，无法登录后台」 |
| 网络错误 | 红色提示：「网络连接失败，请检查网络后重试」 |

#### 8.5.5 全局错误处理

| 状态 | 设计 |
|------|------|
| 全局网络中断 | 顶部横幅：「网络连接已中断」+ 黄色背景，持续显示直到恢复 |
| 403 权限不足 | 居中页面：「无权限访问此页面」+ [返回首页] 按钮 |
| 404 页面 | 居中页面：「页面不存在」+ [返回首页] 按钮 |
| 500 服务异常 | 居中页面：「服务暂时不可用，请稍后重试」+ [重试] 按钮 |

---

## 9. 安全设计

### 9.1 密码安全

| 措施 | 实现 |
|------|------|
| 哈希算法 | bcryptjs，salt rounds = 10 |
| 密码传输 | 明文通过 HTTPS 传输（生产环境要求 HTTPS） |
| 密码存储 | 仅存储 bcrypt 哈希值，不可逆 |
| 默认密码 | 管理员创建用户时自动生成随机8位密码（字母+数字） |
| 管理员初始密码 | 写入 `.admin-credentials` 文件（权限 600），不输出到控制台 |
| 密码修改 | 修改密码后 token_version +1，所有设备令牌立即失效 |

### 9.2 令牌安全

| 措施 | 实现 |
|------|------|
| 签名算法 | HMAC-SHA256（jsonwebtoken 默认） |
| JWT_SECRET | 256位随机字符串，首次启动自动生成并写入 .env |
| access_token 有效期 | 15 分钟 |
| refresh_token 有效期 | 7 天（记住我：30 天） |
| 令牌轮换 | 每次刷新发放新 refresh token，旧 token 加入黑名单 |
| 全局吊销 | 修改密码/禁用用户时递增 token_version，旧版本令牌全部失效，无需黑名单 |
| 登出吊销 | 登出时将当前 refresh token 加入黑名单 |

### 9.3 token 黑名单清理

| 清理时机 | 说明 |
|---------|------|
| 每次 store 写入时 | 删除 `expires_at < now()` 的条目 |
| 每次 store 读取时 | 同样执行清理，确保低活跃期也能回收 |
| 设计原则 | 仅登出和令牌轮换进入黑名单；全局吊销通过 token_version 实现，不产生黑名单条目 |

### 9.4 登录频率限制

| 维度 | 限制 | 超出后处理 |
|------|------|-----------|
| 单 IP | 5 次/分钟 | 返回 429 LOGIN_RATE_LIMITED，提示 60 秒后重试 |
| 单账号 | 10 次/分钟 | 同上 |
| 连续失败 | 同账号连续 5 次错误 | 锁定 15 分钟（可在管理员后台手动解锁） |

限流计数器存储在内存中（服务重启后清零），不持久化。接口返回 429 时携带 `Retry-After: 60` 头。连续失败锁定策略持久化到 `store.json` 中，重启不丢失。

### 9.5 防护措施

| 措施 | 说明 |
|------|------|
| 常量时间密码比较 | bcryptjs 内置 |
| 防止自己禁用自己 | 后端校验 `target_user_id !== req.user.id` |
| 防止降级最后一个 admin | 修改角色为非 admin 时，检查租户下是否还有其他 admin |
| 防止删除最后一个 admin | 禁用/删除时同样检查 |
| 管理员后台双重鉴权 | 前端 role 校验 + 后端 adminRequired() 中间件 |
| 禁用用户立即生效 | token_version +1，所有设备立即登出 |
| API 序列化安全 | 统一排除 password_hash 和 token_version 字段（见 6.4 节） |

---

## 10. 技术实现

### 10.1 新增依赖

```json
{
  "jsonwebtoken": "^9.0.0",
  "bcryptjs": "^2.4.3"
}
```

bcryptjs 选择纯 JavaScript 实现，无需 node-gyp 编译，跨平台兼容。

### 10.2 新增文件

```
backend/src/
  auth/
    auth.js              # JWT 签发/验证 + bcryptjs 密码哈希
  middleware/
    auth.js              # authRequired() + adminRequired() 中间件
  routes/
    admin.js             # 管理员用户 CRUD + 审计日志

admin/                    # 独立管理员后台
  package.json
  src/
    static-server.js      # 端口 3001
    index.html            # 后台登录页 + 管理界面（Tab切换 + 空态/Loading/错误态）
    app.js                # 用户列表/CRUD/搜索分页/审计日志
    styles.css            # 后台样式（复用设计令牌）
```

### 10.3 修改文件

```
backend/src/
  store/store.js          # 种子管理员(.admin-credentials文件) + 向后兼容迁移 + 审计日志 + 查询辅助函数 + token_version支持
  server.js               # JWT_SECRET 初始化 + 登录频率限制计数器
  routes/index.js         # 新增 auth 路由 + 路由保护 + 替换硬编码 ID + 序列化安全

frontend/src/
  index.html              # 新增登录容器 + 修改密码弹窗 + 过渡页 + 侧边栏用户区
  app.js                  # 认证状态 + api() 拦截器(leader-follower) + init 流程 + 修改密码
  styles.css              # 新增登录页样式 + 修改密码弹窗样式 + 过渡页样式 + 骨架屏/空态样式
```

### 10.4 关键实现细节

**auth.js 核心函数：**
```javascript
hashPassword(plaintext) → Promise<string>       // bcryptjs.hash, rounds=10
verifyPassword(plaintext, hash) → Promise<bool>  // bcryptjs.compare
createAccessToken(user) → string                 // jwt.sign, expiresIn: 15min (携带 token_version)
createRefreshToken(user, rememberMe) → string     // jwt.sign, expiresIn: 7d or 30d
verifyToken(token, secret) → payload|null        // jwt.verify + token_version 校验
generateTempPassword() → string                  // crypto.randomBytes(8).toString('hex')
serializeUser(user) → object                     // 排除 password_hash 和 token_version
```

**中间件集成方式：**

在 `routes/index.js` 的 `route()` 函数中，先于所有路由匹配执行：
```javascript
const PUBLIC_ROUTES = [
  { method: 'GET', pattern: /^\/health$/ },
  { method: 'GET', pattern: /^\/v1\/system\/capabilities$/ },
  { method: 'POST', pattern: /^\/v1\/auth\/login$/ },
  { method: 'POST', pattern: /^\/v1\/auth\/refresh$/ },
];

if (!isPublicRoute(req.method, pathname)) {
  const auth = await authRequired(req);
  req.user = auth.user;
  req.tenantId = auth.tenantId;
}
```

**api() 拦截器改造（前端，含 leader-follower 并发控制）：**
```javascript
async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.accessToken) {
    headers["Authorization"] = `Bearer ${state.accessToken}`;
  }
  let res = await fetch(`${API_BASE}${path}`, { headers, ...options });

  if (res.status === 401 && state.refreshToken) {
    // Leader-follower: 多个并发请求共享同一个 refresh Promise
    if (!state.refreshPromise) {
      state.refreshPromise = refreshAccessToken().finally(() => {
        state.refreshPromise = null;
      });
    }
    const newToken = await state.refreshPromise;
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`;
      res = await fetch(`${API_BASE}${path}`, { headers, ...options });
    }
  }

  if (res.status === 401) {
    clearAuth();
    showLogin();
    throw new Error("登录已过期，请重新登录");
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.message || payload.error || "请求失败");
  return payload.data;
}
```

---

## 11. 验收标准

### 11.1 认证闭环

| 场景 | 验收条件 |
|------|---------|
| 正确密码登录 | 返回 access_token + refresh_token + user，前端进入主应用 |
| 错误密码登录 | 返回 401，显示「密码错误」 |
| 不存在的邮箱 | 返回 401，显示「账号不存在」 |
| 禁用账号登录 | 返回 403，显示「账号已禁用」 |
| 无 token 访问 API | 返回 401 AUTH_REQUIRED |
| 过期 token 访问 API | 返回 401 TOKEN_EXPIRED，前端自动 refresh |
| 并发 refresh | 多个请求同时过期，只有一个执行 refresh，其余等待，全部成功 |
| refresh 成功 | 前端无感知，原请求重试成功 |
| refresh 失败 | 前端清除令牌，跳转登录页 |
| 登出 | refresh token 加入黑名单，后续 refresh 请求被拒绝 |
| 记住我勾选 | refresh_token 有效期 30 天，侧边栏显示有效期 |
| 记住我不勾选 | refresh_token 有效期 7 天 |
| 修改密码 | 所有设备令牌失效，展示过渡页 → 自动跳转登录页 |
| 修改密码过渡页 | 3 秒倒计时 + 「立即登录」按钮，用户理解发生了什么 |
| 登录频率限制 | 同 IP 1 分钟内第 6 次登录返回 429，提示 60 秒后重试 |
| 连续失败锁定 | 同账号连续 5 次错误密码后锁定 15 分钟 |

### 11.2 管理员后台

| 场景 | 验收条件 |
|------|---------|
| admin 登录后台 | 展示身份确认过渡页 → 自动进入用户管理界面 |
| 免密过渡页点击退出 | 清除令牌，跳回后台登录页 |
| operator 登录后台 | 返回 403，前端显示「此账号非管理员」 |
| 创建用户 | 弹窗展示脱敏密码（可切换查看）+ 一键复制 + 红色仅一次警告 |
| 创建成功弹窗关闭 | 密码不可再次查看 |
| 创建用户（已存在的邮箱） | 返回 409 EMAIL_ALREADY_EXISTS |
| 编辑用户 | 修改姓名/角色/状态/额度生效 |
| 禁用用户 | 被禁用用户立即无法登录（token_version +1），当前会话失效 |
| 重置密码 | 弹窗展示新密码（同创建时的安全交互），旧密码立即失效 |
| 不能禁用自己 | 返回 422 CANNOT_DISABLE_SELF |
| 不能降级最后一个 admin | 返回 422 CANNOT_DEMOTE_LAST_ADMIN |
| 搜索用户 | 输入邮箱或姓名关键词，列表实时过滤 |
| 搜索无结果 | 显示「未找到匹配「xxx」的用户」+ 清除搜索 |
| 空列表 | 显示「暂无用户」+「创建第一个用户」引导按钮 |
| 分页 | 超过 20 个用户时显示分页控件 |
| 操作日志 | 所有管理操作可追溯 |
| Tab 切换 | 用户管理和操作日志独立滚动，切换时保留各自状态 |
| 加载中 | 表格区域显示骨架屏 |
| 提交中 | 按钮显示 spinner + 防重复点击 |

### 11.3 数据隔离

| 场景 | 验收条件 |
|------|---------|
| 用户 A 创建任务 | 仅用户 A 可见 |
| 用户 B 查看任务列表 | 看不到用户 A 的任务 |
| 用户 A 查看额度 | 仅显示自己的额度 |
| 系统模特 | 所有用户可见并且可选 |
| 自定义模特 | 仅创建者可见 |
| 服装资产 | 仅上传者可见 |
| 统计看板 | 仅统计当前用户自己的数据 |
| 管理员查看所有用户数据 | admin 可查看租户下所有用户的数据（通过管理后台） |
| API 不返回敏感字段 | 所有用户接口不返回 password_hash 和 token_version |

### 11.4 安全验收

| 场景 | 验收条件 |
|------|---------|
| 管理员初始密码 | 写入 `.admin-credentials` 文件（权限 600），控制台不输出明文 |
| .admin-credentials 权限 | 文件仅所有者可读写 |
| 连续失败锁定 | 5 次错误后锁定 15 分钟，管理员后台可手动解锁 |

---

## 12. 实施计划

| 阶段 | 内容 | 预估工作量 |
|------|------|-----------|
| 阶段1 | 后端基础设施：auth.js + middleware + store 迁移（含 token_version + .admin-credentials） + server.js（含限流计数器） | 3 个新文件，2 个修改 |
| 阶段2 | 后端 API：admin.js 路由（含审计日志 + 序列化安全）+ routes/index.js 改造 | 1 个新文件，1 个修改 |
| 阶段3 | 前端改造：登录页 + 记住我 + 修改密码 + 过渡页 + leader-follower 拦截器 + 侧边栏用户区 + 空态/Loading/错误态 | 3 个文件修改 |
| 阶段4 | 管理员独立后台：admin/ 完整应用（独立登录页 + 身份确认过渡页 + Tab切换 + 用户管理 + 搜索分页 + 密码安全展示 + 骨架屏/空态 + 操作日志） | 5 个新文件 |

---

## 13. 附录

### A. 后续版本规划

| 版本 | 内容 |
|------|------|
| v2.0 Part 2 | 批量商用生产工作台：项目/SKU管理、批量上传、批量生成、参数模板、生产看板 |
| v2.0.1 | 密码强度策略、登录失败锁定（5次错误锁定30分钟，管理员手动解锁）、忘记密码/自助找回（邮箱验证码）、用户自助注册（管理员审核） |
| v2.0.2 | 租户管理（多租户创建/配置/删除）、租户级额度池、租户间数据完全隔离 |
| v2.1 | OAuth/SSO 集成、API Key 管理（第三方集成）、完整审计日志（含业务操作）、MFA 多因素认证 |
| 长期 | token 黑名单升级为 Redis（key 自动过期），或全面切换为 token_version 无状态吊销方案，去除黑名单机制 |

### B. 与 v1.0.2 的兼容性

- 现有 `store.json` 数据自动迁移，无需手动操作
- 现有 API 端点路径不变，仅增加认证头要求
- 生产数据（73个任务、51个结果等）归属升级后的管理员用户
- 如降级回 v1.0.2：需手动将 routes/index.js 中硬编码 ID 恢复为 `"user-demo"` / `"tenant-demo"`，并移除 auth 中间件调用

### C. 版本演进全景

```
v1.0     — 核心虚拟穿衣闭环（图片 + 30秒视频）
v1.0.1   — 商用品质链路（多候选/五维评分/四级分级/高清门槛）
v1.1     — 可用性增强（智能体主入口/两段式推荐/预检模块/任务详情/结果管理）
v1.0.2   — 定稿版（整合上述全部 + 多模型供应商 + 商品一致性自动重试 + 模型栈管理）
v2.0 P1  — 用户系统（本文档）：多租户认证/角色权限/管理员后台/数据隔离
v2.0 P2  — 批量商用生产工作台（后续）：项目/SKU/批量生成/参数模板/生产看板
v2.0.1   — 安全增强 + 用户自助
v2.1     — 集成开放：OAuth/SSO/API Key
```
