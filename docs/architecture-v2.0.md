# 架构设计文档

## AI虚拟人穿衣 SaaS v2.0 — 用户系统

| 字段 | 内容 |
|------|------|
| 版本 | v2.0 Part 1 — 用户系统 |
| 基线架构 | v1.0.2 定稿版（单租户/零认证/JSON文件存储） |
| 依据PRD | `docs/prd/AI虚拟人穿衣SaaS_PRD_v2.0_用户系统.md` |
| 日期 | 2026-05-18 |
| 设计原则 | 最小依赖、零框架、纯 Node.js 运行时、JSON 文件存储、渐进演进 |

---

## 1. v1.0.2 现状架构

```
┌─────────────────────────────────────────────────────────┐
│  localhost:3000                    localhost:4000       │
│  ┌──────────────┐                ┌──────────────────┐  │
│  │  frontend/   │   HTTP/JSON    │   backend/       │  │
│  │  static-     │ ────────────── │   server.js      │  │
│  │  server.js   │  (no auth)     │   routes/        │  │
│  │  index.html  │                │   services/      │  │
│  │  app.js      │                │   store/         │  │
│  │  styles.css  │                │   ai/            │  │
│  └──────────────┘                │   storage/       │  │
│                                  └──────┬───────────┘  │
│                                         │               │
│                                  ┌──────▼───────────┐  │
│                                  │  data/store.json │  │
│                                  │  (单租户单用户)  │  │
│                                  └──────────────────┘  │
└─────────────────────────────────────────────────────────┘

硬编码: user-demo / tenant-demo (routes/index.js)
认证: 无
权限: 无
用户隔离: 无
```

---

## 2. v2.0 目标架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  localhost:3000          localhost:3001          localhost:4000      │
│  (主工作台)              (管理员后台)            (API 后端)           │
│                                                                      │
│  ┌────────────┐         ┌────────────┐         ┌────────────────┐   │
│  │ frontend/  │         │ admin/     │         │ backend/       │   │
│  │            │         │            │         │                │   │
│  │ 登录页    │         │ 独立登录页│         │ server.js      │   │
│  │ 主应用壳  │         │ 身份确认  │         │                │   │
│  │ api()拦截 │         │ 过渡页    │         │ ┌────────────┐ │   │
│  │ leader-   │         │           │         │ │ auth/      │ │   │
│  │ follower  │         │ 用户管理  │         │ │ auth.js    │ │   │
│  │ refresh   │         │ Tab       │         │ │ (JWT+bcrypt)│   │
│  │           │         │ 操作日志  │         │ └────────────┘ │   │
│  │ 修改密码  │         │ Tab       │         │                │   │
│  │ 过渡页    │         │           │         │ ┌────────────┐ │   │
│  │           │         │ 骨架屏    │         │ │middleware/ │ │   │
│  │ 侧边栏    │         │ 空态      │         │ │auth.js     │ │   │
│  │ 用户区    │         │ 错误态    │         │ │(authRequired│   │
│  └─────┬─────┘         └─────┬─────┘         │ │ adminReq)  │ │   │
│        │                     │               │ └────────────┘ │   │
│        │    JWT Bearer       │               │                │   │
│        └─────────────────────┘               │ ┌────────────┐ │   │
│                  │                           │ │ routes/    │ │   │
│                  │                           │ │ index.js   │ │   │
│                  │    ┌──────────────────────│ │ admin.js   │ │   │
│                  └────▶    POST /v1/auth/*   │ └────────────┘ │   │
│                       │  GET  /v1/admin/*    │                │   │
│                       │  (所有业务端点)      │ ┌────────────┐ │   │
│                       │                      │ │ store/     │ │   │
│                       │                      │ │ store.js   │ │   │
│                       │                      │ │ (扩展模型) │ │   │
│                       │                      │ └─────┬──────┘ │   │
│                       └──────────────────────┘       │        │   │
│                                              ┌──────▼──────┐ │   │
│                                              │store.json   │ │   │
│                                              │+ users扩展  │ │   │
│                                              │+ 审计日志   │ │   │
│                                              │+ token黑名单│ │   │
│                                              │+ .admin-    │ │   │
│                                              │  credentials│ │   │
│                                              └─────────────┘ │   │
│                                                backend/      │   │
└──────────────────────────────────────────────────────────────────────┘
```

### 核心架构变更总结

| 维度 | v1.0.2 | v2.0 |
|------|--------|------|
| 进程数 | 2 (frontend:3000 + backend:4000) | 3 (frontend:3000 + admin:3001 + backend:4000) |
| 认证 | 无 | JWT access/refresh 双令牌 |
| 密码 | 无 | bcryptjs hash (rounds=10) |
| 权限 | 无 | RBAC: admin / operator |
| 用户数据 | 硬编码 user-demo | 动态用户，按 user_id 隔离 |
| 依赖 | 0 个 npm 依赖 | 2 个: jsonwebtoken + bcryptjs |
| 模块数 | 8 个 | 11 个（新增 auth/auth.js, middleware/auth.js, routes/admin.js） |
| 端口 | 3000 + 4000 | 3000 + 3001 + 4000 |

---

## 3. 后端架构

### 3.1 模块分解

```
backend/src/
├── server.js              # 入口：JWT_SECRET 初始化 + 限流计数器 + HTTP 服务
├── env.js                 # 环境变量加载（不变）
├── auth/
│   └── auth.js            # [新增] JWT 签发/验证 + bcrypt 密码哈希 + serializeUser
├── middleware/
│   └── auth.js            # [新增] authRequired() + adminRequired() 中间件
├── routes/
│   ├── index.js           # [修改] 路由注册 + 公开路由白名单 + 认证中间件注入
│   └── admin.js           # [新增] 管理员用户 CRUD + 审计日志查询
├── services/
│   ├── agent.js           # [修改] 移除硬编码 user
│   ├── garment.js         # 不变
│   ├── quality.js         # 不变
│   ├── task-runner.js     # [修改] user_id 传递
│   ├── validation.js      # 不变
│   └── constants.js       # 不变
├── store/
│   └── store.js           # [修改] 种子管理员 + 向后兼容迁移 + 审计日志 + 辅助查询
├── ai/
│   └── model-gateway.js   # 不变
└── storage/
    └── oss.js             # 不变
```

### 3.2 新增模块设计

#### 3.2.1 `auth/auth.js` — 认证核心

**职责**：JWT 令牌生命周期管理 + 密码哈希 + 用户序列化

**导出函数**：

| 函数 | 签名 | 说明 |
|------|------|------|
| `hashPassword` | `(plaintext) → Promise<string>` | bcryptjs.hash, salt rounds=10 |
| `verifyPassword` | `(plaintext, hash) → Promise<bool>` | bcryptjs.compare |
| `createAccessToken` | `(user) → string` | jwt.sign, expiresIn: 15min, 载荷含 sub/tenant_id/email/role/token_version |
| `createRefreshToken` | `(user, rememberMe?) → string` | jwt.sign, expiresIn: 7d(默认) 或 30d(记住我), 载荷含 type:"refresh" |
| `verifyToken` | `(token) → payload\|null` | jwt.verify + token_version 校验 |
| `generateTempPassword` | `() → string` | crypto.randomBytes(8).toString("hex") |
| `serializeUser` | `(user) → object` | 排除 password_hash 和 token_version，返回白名单字段 |

**JWT 载荷结构**：

```
Access Token:
{
  sub: "user_xxx",           // 用户 ID
  tenant_id: "tenant-demo",  // 租户 ID
  email: "user@test.com",    // 邮箱
  role: "admin",             // 角色
  token_version: 3,          // 令牌版本（与用户记录比对）
  iat: 1700000000,           // 签发时间
  exp: 1700000900,           // 过期时间（15min）
  jti: "random_hex_16"       // 令牌唯一 ID
}

Refresh Token:
{ ...同上, type: "refresh", exp: 1700604800 }  // 7d 或 30d
```

**关键设计决策**：

- `verifyToken` 需要读取 store 以校验 token_version。传入当前用户记录进行比对。
- JWT_SECRET 由 server.js 在首次启动时自动生成 256 位随机字符串并写入 .env。
- Refresh token 载荷中携带 `type: "refresh"` 字段，防止 access token 被当作 refresh token 使用。

#### 3.2.2 `middleware/auth.js` — 认证中间件

**职责**：请求级身份验证和角色鉴权

**导出函数**：

| 函数 | 签名 | 说明 |
|------|------|------|
| `authRequired` | `(req) → Promise<{user, tenantId}>` | 解析 Authorization header → 验证 JWT → 校验 token_version → 返回用户信息。失败抛相应错误 |
| `adminRequired` | `(req) → Promise<void>` | 先执行 authRequired → 检查 role === "admin" → 非 admin 抛 FORBIDDEN |

**错误抛出协议**：

```javascript
// 中间件通过抛出带 statusCode 属性的 Error 来传递错误
throw Object.assign(new Error("未提供认证令牌"), { statusCode: 401, code: "AUTH_REQUIRED" });
throw Object.assign(new Error("令牌已过期"), { statusCode: 401, code: "TOKEN_EXPIRED" });
throw Object.assign(new Error("权限不足"), { statusCode: 403, code: "FORBIDDEN" });
```

这些错误由 routes/index.js 的顶层 catch 统一处理。

#### 3.2.3 `routes/admin.js` — 管理员路由

**职责**：管理员后台 API（用户 CRUD + 操作日志）

**路由表**：

| 方法 | 路径 | 处理器 | 中间件 |
|------|------|--------|--------|
| GET | `/v1/admin/users` | `listUsers` | adminRequired |
| POST | `/v1/admin/users` | `createUser` | adminRequired |
| PUT | `/v1/admin/users/:id` | `updateUser` | adminRequired |
| DELETE | `/v1/admin/users/:id` | `disableUser` | adminRequired |
| POST | `/v1/admin/users/:id/reset-password` | `resetUserPassword` | adminRequired |
| GET | `/v1/admin/audit-logs` | `listAuditLogs` | adminRequired |

**设计要点**：

- 每个处理器使用 `updateStore()` 确保原子写入
- `createUser` 调用 `hashPassword(generateTempPassword())`，返回明文密码仅此一次
- `disableUser` 检查 CANNOT_DISABLE_SELF 和 CANNOT_DEMOTE_LAST_ADMIN
- 所有响应中用户数据通过 `serializeUser()` 过滤
- 操作自动写入 `admin_audit_logs`

**数据流示意（createUser）**：

```
admin:3001                    backend:4000                     store.json
    │                              │                              │
    │  POST /v1/admin/users        │                              │
    │  {email, name, role}         │                              │
    │ ────────────────────────────▶│                              │
    │                              │  adminRequired(req)          │
    │                              │  → 验证 JWT + admin 角色    │
    │                              │                              │
    │                              │  password = tempPwd()        │
    │                              │  hash = hashPassword(pwd)    │
    │                              │  updateStore(store => {     │
    │                              │    store.users.push(user)    │──▶
    │                              │    store.admin_audit_logs    │
    │                              │      .push(logEntry)        │
    │                              │    return {user, password}   │
    │                              │  })                          │
    │                              │                              │
    │  {user: {...},               │                              │
    │   password: "a3f8c2e1"}     │                              │
    │ ◀────────────────────────────│                              │
```

### 3.3 修改模块设计

#### 3.3.1 `routes/index.js` — 路由注册改造

**改造点**：

1. **公开路由白名单**：
   ```javascript
   const PUBLIC_ROUTES = [
     { method: "GET",  pattern: /^\/health$/ },
     { method: "GET",  pattern: /^\/v1\/system\/capabilities$/ },
     { method: "POST", pattern: /^\/v1\/auth\/login$/ },
     { method: "POST", pattern: /^\/v1\/auth\/refresh$/ },
   ];
   ```

2. **认证中间件注入**（在路由匹配前执行）：
   ```javascript
   async function route(req, res) {
     // ... OPTIONS 处理 ...
     if (!isPublicRoute(req.method, pathname)) {
       try {
         const auth = await authRequired(req);
         req.userId = auth.user.id;
         req.tenantId = auth.user.tenant_id;
         req.userRole = auth.user.role;
       } catch (err) {
         send(res, err.statusCode || 401, { error: err.code, message: err.message });
         return;
       }
     }
     // ... 现有路由逻辑 ...
   }
   ```

3. **硬编码 ID 替换**：所有 `"user-demo"` → `req.userId`，所有 `"tenant-demo"` → `req.tenantId`

4. **数据隔离**：查询 store 时增加 user_id 过滤（系统模特等共享数据除外）

5. **认证路由注册**：`POST /v1/auth/login`、`POST /v1/auth/refresh`、`POST /v1/auth/logout`、`GET /v1/auth/me`、`POST /v1/auth/change-password`

#### 3.3.2 `store/store.js` — 数据层扩展

**新增/修改函数**：

| 函数 | 说明 |
|------|------|
| `findUserByEmail(store, email)` | 按邮箱查找用户 |
| `countAdmins(store)` | 统计租户下 admin 角色用户数 |
| `ensureStoreShape(store)` | [修改] 增加 v2.0 向后兼容迁移逻辑 |
| `seedAdmin()` | [新增] 首次初始化创建默认管理员，密码写入 `.admin-credentials` |
| `cleanExpiredTokens(store)` | 清除过期 refresh token 黑名单条目 |

**ensureStoreShape 迁移逻辑**：对现有用户补充缺失字段（email、password_hash、role="admin"、status="active"、token_version=1）。新增顶层字段 `admin_audit_logs` 和 `refresh_token_blacklist`。

**种子管理员**：首次启动且 users 为空时创建 admin@tryonstudio.local，随机 8 位 hex 密码写入 `.admin-credentials`（权限 600），控制台仅提示文件路径不输出明文。

#### 3.3.3 `server.js` — 入口改造

1. **JWT_SECRET 初始化**：启动时检查 `process.env.JWT_SECRET`，不存在则生成 256 位随机 hex 并追加写入 `.env`
2. **登录限流计数器**：内存 Map，key 为 `ip:xxx` 和 `email:xxx`

---

## 4. 前端架构（主工作台 localhost:3000）

### 4.1 认证状态机

```
                    ┌──────────┐
                    │ 页面加载  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ localStorage
                    │ 有 token? │
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │ 有                   │ 无
         ┌────▼─────┐          ┌────▼─────┐
         │ GET /v1/ │          │ 显示     │
         │ auth/me  │          │ 登录页   │
         └────┬─────┘          └──────────┘
              │
    ┌─────────┼─────────┐
    │ 有效               │ 过期
    │                    │
┌───▼───┐          ┌────▼─────┐
│进入主  │          │ POST /v1/│
│应用    │          │ auth/    │
│工作台  │          │ refresh  │
└───────┘          └────┬─────┘
                        │
              ┌─────────┼─────────┐
              │ 成功              │ 失败
          ┌───▼───┐          ┌───▼───┐
          │更新    │          │清除    │
          │token   │          │token   │
          │进入    │          │显示    │
          │主应用  │          │登录页  │
          └───────┘          └───────┘
```

### 4.2 前端改造清单

| 文件 | 改造内容 |
|------|---------|
| `index.html` | 新增登录容器（登录卡片、记住我复选框、错误提示区域）、侧边栏底部用户信息区（含登录有效期提示）、修改密码弹窗、修改密码成功过渡页、403/404/500 状态页 |
| `app.js` | 认证状态管理 `state.auth`、`api()` 拦截器（自动注入 Authorization header + leader-follower refresh）、`init()` 流程改造（先验证认证状态再初始化应用）、修改密码逻辑 |
| `styles.css` | 登录页样式、登录卡片动画、修改密码弹窗样式、过渡页样式、侧边栏用户区样式 |

### 4.3 api() 拦截器设计（Leader-Follower 模式）

```
请求A 返回 401
  │
  ├─ state.refreshPromise 是否存在？
  │    ├─ 不存在 → 创建 state.refreshPromise = refreshAccessToken()
  │    │             │
  │    │             ├─ 成功 → 更新 state.accessToken, state.refreshToken
  │    │             │         → localStorage 同步更新
  │    │             │         → 返回新 token
  │    │             │
  │    │             └─ 失败 → clearAuth(), showLogin()
  │    │                       → throw "登录已过期"
  │    │
  │    └─ 存在 → await state.refreshPromise（等待 leader 的刷新结果）
  │              │
  │              ├─ leader 成功 → 用新 token 重试原始请求
  │              └─ leader 失败 → clearAuth(), showLogin()
  │
  └─ 重试原请求(带新 token) → 成功返回 data
```

---

## 5. 管理员后台架构（localhost:3001）

### 5.1 概览

管理员后台是独立的前端应用，运行在端口 3001，与主工作台（3000）共享同一个后端 API（4000）。

```
admin/
├── package.json           # 依赖: 无（纯静态服务，复用 http 模块）
├── src/
│   ├── static-server.js   # HTTP 服务，端口 3001，服务静态文件
│   ├── index.html         # 后台登录页 + 身份确认过渡页 + 主界面框架（Tab 结构）
│   ├── app.js             # 认证 + API 调用 + 用户管理逻辑 + 操作日志
│   └── styles.css         # 后台专属样式（骨架屏、表格、弹窗、分页等）
```

### 5.2 页面结构

```
index.html (单页应用)
├── 后台登录页（未认证时显示）
├── 身份确认过渡页（已认证且为 admin 时显示，约 2 秒）
└── 主界面（认证为 admin 后显示）
    ├── 顶栏（标题 + 管理员信息 + 登出）
    ├── Tab 栏 [用户管理] [操作日志]
    ├── 用户管理 Tab
    │   ├── 工具栏（新增用户按钮 + 搜索框 + 角色/状态筛选）
    │   ├── 用户表格（骨架屏 / 空态 / 数据行 / 操作按钮）
    │   └── 分页控件
    ├── 操作日志 Tab
    │   ├── 日志表格（骨架屏 / 空态 / 数据行）
    │   └── 分页控件
    └── 弹窗层
        ├── 新增用户弹窗（含密码展示安全交互）
        ├── 编辑用户弹窗
        ├── 重置密码确认弹窗（含密码展示安全交互）
        └── 禁用/启用确认弹窗
```

### 5.3 跨端口 localStorage 说明

主应用（3000）和后台（3001）运行在不同端口，**不共享 localStorage**（localStorage 按 origin 隔离）。管理员在两个应用中需各自登录。生产环境可通过 Nginx 反向代理统一域名解决，当前开发阶段保持独立登录。

---

## 6. 数据库设计（store.json 完整变更）

### 6.1 数据库技术说明

项目使用 **JSON 文件存储**（`backend/data/store.json`）作为持久化层，零外部数据库依赖。所有数据在启动时加载到内存，通过 `updateStore()` 原子写入（promise 互斥锁序列化）。适合 MVP 阶段的数据规模和运维简单性要求。

### 6.2 顶层结构变更对照

```
v1.0.2 store.json                    v2.0 store.json
─────────────────────────────────    ─────────────────────────────────
{                                     {
  tenants: [...],                       tenants: [...],          // 字段扩展
  users: [...],                         users: [...],            // 字段扩展
  garments: [...],                      garments: [...],         // 字段扩展
  model_assets: [...],                  model_assets: [...],     // 字段扩展
  tasks: [...],                         tasks: [...],            // 不变
  results: [...],                       results: [...],          // 不变
  credit_logs: [...],                   credit_logs: [...],     // 不变
  events: [...],                        events: [...],           // 不变
  model_library_changes: [...],         model_library_changes: [...], // 不变
  created_at,                           created_at,
  updated_at,                           updated_at,
                                        refresh_token_blacklist: [],  // [新增]
                                        admin_audit_logs: [],         // [新增]
                                        login_lockouts: {}            // [新增]
}                                     }
```

### 6.3 各集合字段级变更明细

#### 6.3.1 tenants — 扩展时间戳

```json
// v1.0.2
{ "id": "tenant-demo", "name": "Demo Fashion Studio", "plan": "pro" }

// v2.0（新增 created_at, updated_at）
{
  "id": "tenant-demo",
  "name": "Demo Fashion Studio",
  "plan": "pro",
  "created_at": "2026-05-18T12:00:00.000Z",   // [新增]
  "updated_at": "2026-05-18T12:00:00.000Z"    // [新增]
}
```

#### 6.3.2 users — 核心变更（6 个新增字段）

```
v1.0.2 字段:                          v2.0 变更:
─────────────────────────────────     ─────────────────────────────
id: "user-demo"                       → 保持，新用户使用 id("user")
tenant_id: "tenant-demo"              → 保持
name: "运营演示账号"                   → 保持
credit_balance: 150                   → 保持
                                      + email: "admin@tryonstudio.local"  [新增]
                                      + password_hash: "$2a$10$..."      [新增]
                                      + role: "admin"                     [新增]
                                      + status: "active"                  [新增]
                                      + token_version: 1                  [新增]
                                      + last_login_at: "ISO时间戳"        [新增]
                                      + created_at: "ISO时间戳"           [新增]
                                      + updated_at: "ISO时间戳"           [新增]
```

**新增字段详情**：

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| email | string | 是 | - | 登录标识，租户内唯一索引（逻辑上） |
| password_hash | string | 是 | - | bcryptjs hash, salt rounds=10 |
| role | enum | 是 | "operator" | "admin" \| "operator" |
| status | enum | 是 | "active" | "active" \| "disabled"，禁用后 token 立即失效 |
| token_version | number | 是 | 1 | 修改密码/禁用时 +1，JWT 载荷携带，验证时比对，实现无黑名单全局吊销 |
| last_login_at | string | 否 | null | 最近登录 ISO 时间戳 |
| created_at | string | 是 | now() | 创建时间 |
| updated_at | string | 是 | now() | 更新时间 |

**唯一性约束**：email 在 tenant 内唯一。在 `createUser` 中校验，通过 `findUserByEmail` 查重。

#### 6.3.3 garments — 补充 user_id

```
v1.0.2 (74条):                        v2.0:
─────────────────────────────────     ─────────────────────────────
id, tenant_id, user_id*, ...          user_id: "user-demo"（补填已有数据）
                                      → 新数据使用 req.userId
```
*注：部分 v1.0.2 记录可能有 `user_id` 字段，迁移时统一检查和补填。

#### 6.3.4 model_assets — 补充 user_id

```
v1.0.2 (29条自定义模特):              v2.0:
─────────────────────────────────     ─────────────────────────────
id, tenant_id, user_id*, ...          user_id: "user-demo"（补填已有数据）
                                      → 新数据使用 req.userId
                                      系统模特 (Eva/Mia/Noah) 不存此表
```

#### 6.3.5 tasks — user_id 已存在，无需变更

```
v1.0.2 (73条):                        v2.0:
─────────────────────────────────     ─────────────────────────────
id, tenant_id, user_id, garment_id,   字段不变
model_id, output_type, prompt,        已有 user_id 字段，迁移时补填
params, status, progress,             "user-demo"
current_stage, message,
credit_cost, failure_reason,
stage_timings, created_at,
updated_at, completed_at
```

#### 6.3.6 results — 无需字段变更

```
v1.0.2 (51条):                        v2.0:
─────────────────────────────────     ─────────────────────────────
id, task_id, media_type, image_url,   字段不变
video_url, cover_url,                 通过关联 task.user_id 实现数据隔离
duration_seconds, score,
quality_status, issue_tags,
model_meta, created_at
```

#### 6.3.7 credit_logs — user_id 已存在，无需变更

```
v1.0.2 (73条):                        v2.0:
─────────────────────────────────     ─────────────────────────────
id, tenant_id, user_id, task_id,      字段不变
amount, direction, reason,            已有 user_id 字段
status, created_at
```

#### 6.3.8 events — 无需变更

```
v1.0.2 (1022条):                      v2.0:
─────────────────────────────────     ─────────────────────────────
id, task_id, status, progress,        字段不变
message, created_at                   通过关联 task.user_id 实现数据隔离
```

#### 6.3.9 model_library_changes — 无需变更

系统模特库的增删改覆盖记录，租户级共享数据，不涉及 user_id。

### 6.4 新增集合

#### 6.4.1 refresh_token_blacklist

```json
{
  "jti": "abc123def456",              // JWT 的 jti（令牌唯一 ID）
  "user_id": "user_xxx",              // 所属用户（用于批量吊销场景）
  "expires_at": "2026-05-25T12:00:00.000Z"  // 黑名单过期时间（等于令牌原过期时间）
}
```

**用途**：登出和令牌轮换时吊销特定 refresh token。

**清理策略**：
- 每次 `writeStore()` 时清理 `expires_at < now()` 的条目
- 每次 `readStore()` 时同样清理（确保低活跃期也能回收）
- 不在写入时主动清理会导致黑名单无限增长

**不进入黑名单的场景**：修改密码和禁用用户通过递增 `token_version` 实现全局吊销，无需将每个 token 加入黑名单。

#### 6.4.2 admin_audit_logs

```json
{
  "id": "audit_a1b2c3d4e5f6g7h8",     // 日志唯一 ID
  "tenant_id": "tenant-demo",          // 租户 ID
  "admin_user_id": "user_admin001",    // 操作管理员 ID
  "action": "user_created",            // 操作类型
  "target_user_id": "user_new001",     // 目标用户 ID
  "detail": {                          // 操作详情（自由格式）
    "email": "new@test.com",
    "role": "operator",
    "changed_fields": ["name", "role"] // user_updated 时记录变更字段
  },
  "created_at": "2026-05-18T12:00:00.000Z"
}
```

**action 枚举**：

| action | 触发操作 | detail 内容 |
|--------|---------|------------|
| user_created | POST /v1/admin/users | `{email, name, role, credit_balance}` |
| user_updated | PUT /v1/admin/users/:id | `{changed_fields: [...], ...}` |
| user_disabled | DELETE /v1/admin/users/:id | `{}` |
| user_enabled | PUT /v1/admin/users/:id (status→active) | `{}` |
| user_password_reset | POST /v1/admin/users/:id/reset-password | `{}` |

**查询支持**：按时间倒序，支持分页（page/page_size）。

#### 6.4.3 login_lockouts（内存 + store.json 持久化）

```json
{
  "user_xxx": {
    "failed_count": 5,
    "locked_until": "2026-05-18T12:15:00.000Z"
  }
}
```

**用途**：连续登录失败锁定。同账号连续 5 次密码错误后锁定 15 分钟。

**存储位置**：
- 登录限流计数器（IP/邮箱维度，5次/min）：存储在 `server.js` 内存 Map 中，重启清零
- 连续失败锁定：持久化到 `store.json` 的 `login_lockouts` 字段，重启不丢失

**解锁方式**：锁定到期自动清除；管理员可通过启用/禁用用户操作间接重置（待 v2.0.1 增加手动解锁功能）。

### 6.5 数据隔离策略

| 数据类别 | 隔离级别 | 查询过滤方式 |
|---------|---------|------------|
| 系统模特 (Eva/Mia/Noah) | 租户级共享 | 不过滤，所有用户可见 |
| 模型栈配置 (capabilities) | 租户级共享 | .env 全局配置 |
| 管理员操作日志 | 租户级共享 | 仅 role=admin 可查询 |
| 自定义模特 (model_assets) | 用户级私有 | `user_id === req.userId` |
| 服装资产 (garments) | 用户级私有 | `user_id === req.userId` |
| 任务 (tasks) | 用户级私有 | `user_id === req.userId` |
| 结果 (results) | 用户级私有 | 关联 task 后 `task.user_id === req.userId` |
| 额度 (credit_balance) | 用户级私有 | 每个 user 独立字段 |
| 额度流水 (credit_logs) | 用户级私有 | `user_id === req.userId` |

### 6.6 自动迁移脚本（ensureStoreShape）

迁移在每次 `readStore()` 时自动执行，对已有数据补充缺失字段：

```
1. 遍历 users[]：
   user.email          → 不存在则设为 "user_<id>@auto.local"
   user.password_hash  → 不存在则设为随机密码的 bcrypt 哈希
                         （该密码不可知，需管理员重置后才能登录）
   user.role           → 不存在则设为 "admin"（历史用户默认管理员）
   user.status         → 不存在则设为 "active"
   user.token_version  → 不存在则设为 1
   user.last_login_at  → 不存在则设为 null
   user.created_at     → 不存在则设为 now()
   user.updated_at     → 不存在则设为 now()

2. 遍历 garments[]：
   garment.user_id     → 不存在则设为 "user-demo"

3. 遍历 model_assets[]：
   asset.user_id       → 不存在则设为 "user-demo"

4. 遍历 tasks[]：
   task.user_id        → 不存在则设为 "user-demo"

5. 遍历 credit_logs[]：
   log.user_id         → 不存在则设为 "user-demo"

6. store 根级别：
   store.refresh_token_blacklist → 不存在则设为 []
   store.admin_audit_logs        → 不存在则设为 []
   store.login_lockouts          → 不存在则设为 {}

7. 遍历 tenants[]：
   tenant.created_at    → 不存在则设为 store.created_at 或 now()
   tenant.updated_at    → 不存在则设为 store.updated_at 或 now()

8. 种子数据：
   如果 store.users.length === 0：
     → 创建默认管理员 admin@tryonstudio.local
     → 随机 8 位 hex 密码写入 .admin-credentials（权限 600）
     → 控制台提示文件路径，不输出明文密码
```

---

## 7. 技术栈与通信架构

### 7.1 运行时环境

| 维度 | 选择 | 说明 |
|------|------|------|
| 运行时 | Node.js (内置模块) | `http`, `fs`, `path`, `crypto` |
| 包管理 | npm | `package.json` 管理 |
| 新增依赖 | jsonwebtoken ^9.0.0, bcryptjs ^2.4.3 | v2.0 首次引入，纯 JS 实现，无需编译 |
| 总依赖数 | 2 | 保持最小依赖原则 |
| 前端 | Vanilla JS (ES5/ES6) | 无框架，fetch API + DOM 操作 |
| 构建工具 | 无 | 零构建，直接运行 .js 文件 |
| 静态服务 | 自实现 `static-server.js` | `http` + `fs.createReadStream` 管道输出 |

### 7.2 进程拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  macOS 本地开发环境 (localhost)                              │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ frontend:3000    │  │ admin:3001       │                 │
│  │ node static-     │  │ node static-     │                 │
│  │ server.js        │  │ server.js        │                 │
│  │ (纯静态文件服务) │  │ (纯静态文件服务) │                 │
│  └────────┬─────────┘  └────────┬─────────┘                 │
│           │    HTTP/JSON        │                            │
│           │    JWT Bearer       │                            │
│           └──────────┬──────────┘                            │
│                      │                                       │
│           ┌──────────▼──────────┐                            │
│           │ backend:4000        │                            │
│           │ node server.js      │                            │
│           │                     │                            │
│           │ ┌─────────────────┐ │                            │
│           │ │ routes/         │ │                            │
│           │ │  index.js       │ │ ← 公开路由白名单           │
│           │ │  admin.js       │ │ ← adminRequired 中间件     │
│           │ │  auth 端点      │ │ ← JWT 签发/验证           │
│           │ └───────┬─────────┘ │                            │
│           │         │           │                            │
│           │ ┌───────▼─────────┐ │                            │
│           │ │ middleware/     │ │                            │
│           │ │  authRequired   │ │ ← 解析 Bearer token       │
│           │ │  adminRequired  │ │ ← role === "admin" 检查   │
│           │ └───────┬─────────┘ │                            │
│           │         │           │                            │
│           │ ┌───────▼─────────┐ │                            │
│           │ │ auth/auth.js    │ │                            │
│           │ │  JWT sign/verify│ │ ← jsonwebtoken            │
│           │ │  bcrypt hash    │ │ ← bcryptjs                │
│           │ │  serializeUser  │ │ ← 安全序列化过滤          │
│           │ └───────┬─────────┘ │                            │
│           │         │           │                            │
│           │ ┌───────▼─────────┐ │                            │
│           │ │ store/store.js  │ │                            │
│           │ │  updateStore()  │ │ ← 原子写（promise 互斥锁）│
│           │ │  findUserByEmail│ │ ← 邮箱查找                │
│           │ │  countAdmins()  │ │ ← admin 计数              │
│           │ └───────┬─────────┘ │                            │
│           │         │           │                            │
│           │ ┌───────▼─────────┐ │                            │
│           │ │ data/store.json │ │ ← 持久化存储              │
│           │ └─────────────────┘ │                            │
│           └─────────────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

### 7.3 通信协议

| 通信路径 | 协议 | 数据格式 | 认证方式 | 说明 |
|---------|------|---------|---------|------|
| frontend:3000 → backend:4000 | HTTP/1.1 | JSON | `Authorization: Bearer <access_token>` | 主工作台所有 API 调用 |
| admin:3001 → backend:4000 | HTTP/1.1 | JSON | `Authorization: Bearer <access_token>` | 管理后台 API 调用（额外校验 admin role） |
| 前端静态资源 | HTTP/1.1 | HTML/CSS/JS | 无 | `fs.createReadStream` 管道输出 |
| 公开端点 (/health, /capabilities) | HTTP/1.1 | JSON | 无 | 无需认证 |
| 认证端点 (/v1/auth/login, /refresh) | HTTP/1.1 | JSON | 无 | 登录和刷新令牌 |

### 7.4 没有使用的外部通信

以下技术在 v2.0 中 **不使用**：

| 技术 | 不使用原因 |
|------|-----------|
| WebSocket / SSE | 任务状态通过轮询 GET /v1/tryon/tasks/:id 获取，无实时推送需求 |
| 消息队列 (Redis/Kafka/RabbitMQ) | 无外部依赖原则；任务调度通过 `setTimeout` 链在进程内实现 |
| 数据库 (MySQL/PostgreSQL/MongoDB) | JSON 文件存储满足 MVP 数据量 |
| gRPC / Protocol Buffers | 纯 JSON REST 通信，无跨服务高性能调用需求 |
| OAuth 2.0 / OpenID Connect | v2.0 不做第三方登录（PRD 标记为 v2.1） |
| 邮件服务 (SMTP/SendGrid) | v2.0 不做忘记密码/自助找回（PRD 标记为 v2.0.1） |
| HTTPS (开发阶段) | 本地开发使用 HTTP；生产环境通过 Nginx 反向代理终止 TLS |

### 7.5 异步任务通信

v2.0 任务调度沿用 v1.0.2 的进程内 `setTimeout` 链模式，不引入外部调度器：

```
POST /v1/tryon/tasks
  │
  └─▶ scheduleTask(task.id)
        │
        └─▶ setTimeout(() => {
              readStore() → 获取最新任务状态
              → 如果 task 已取消 → 停止
              → 调用 AI 模型网关生成图片/视频
              → updateStore() → 写入结果
              → 判断是否完成
                → 未完成 → setTimeout(下一个阶段)
                → 完成 → settleTask() → 质量评分 → 结束
            }, delay)
```

**关键点**：
- 任务调度器和 API 服务器运行在同一 Node.js 进程中
- 通过 `updateStore()` 的互斥锁与 HTTP 请求处理安全并发
- 取消操作通过检查 `task.status === "cancelled"` 实现协作式取消
- `scheduleTask` 为 async 函数，不阻塞 HTTP 响应

### 7.6 CORS 策略

开发阶段所有响应设置 `Access-Control-Allow-Origin: *`，允许 localhost:3000 和 localhost:3001 跨端口调用 localhost:4000。生产环境改为白名单域名。

---

## 8. 认证与授权流程

### 7.1 登录时序

```
浏览器                     后端                          store.json
  │                          │                              │
  │  POST /v1/auth/login     │                              │
  │  {email, pwd, remember}  │                              │
  │ ────────────────────────▶│                              │
  │                          │  findUserByEmail(email)      │
  │                          │  → 不存在: 401               │
  │                          │  → status=disabled: 403      │
  │                          │  verifyPassword(pwd, hash)   │
  │                          │  → 失败: 401 + 限流计数      │
  │                          │                              │
  │                          │  createAccessToken(user)     │
  │                          │  createRefreshToken(user,    │
  │                          │    rememberMe)               │
  │                          │                              │
  │                          │  updateStore(s => {          │
  │                          │    user.last_login_at=now    │
  │                          │  })                          │
  │                          │ ────────────────────────────▶│
  │                          │                              │
  │  {access_token,          │                              │
  │   refresh_token,         │                              │
  │   user: serializeUser}   │                              │
  │ ◀────────────────────────│                              │
  │                          │                              │
  │  存储到 localStorage     │                              │
```

### 7.2 令牌刷新（Leader-Follower）

```
请求A (401)           请求B (401)          后端
    │                     │                  │
    │ state.refreshP      │                  │
    │ === null?           │                  │
    │ → 创建并缓存        │                  │
    │                     │ state.refreshP   │
    │                     │ !== null         │
    │                     │ → await 等待     │
    │                     │                  │
    ├─────────────────────┤                  │
    │ POST /v1/auth/refresh                  │
    │ ──────────────────────────────────────▶│
    │                     │  verifyToken +   │
    │                     │  token_version   │
    │                     │  旧token→黑名单  │
    │                     │  新token签发     │
    │                     │                  │
    │ {new_access_token, new_refresh_token}  │
    │ ◀──────────────────────────────────────│
    │                     │                  │
    │ state.refreshP=null │                  │
    │ resolve(新token)  → resolve(新token)   │
    │ 重试原请求         → 重试原请求        │
```

---

## 8. 安全设计

### 8.1 安全层次

| 层次 | 措施 |
|------|------|
| 传输层 | 生产环境 HTTPS |
| 认证层 | JWT access_token(15min) + refresh_token(7d/30d)；token_version 全局吊销；refresh token 轮换+黑名单 |
| 授权层 | authRequired() 验证 JWT；adminRequired() 验证 role；业务层 user_id 过滤 |
| 防护层 | 登录限流(IP 5次/min + 账号 10次/min)；连续失败锁定(5次→15min)；bcryptjs 常量时间比较；管理员自保护；最后一个 admin 保护 |
| 序列化 | serializeUser() 统一排除 password_hash 和 token_version |

### 8.2 限流实现

限流计数器存储在 `server.js` 作用域内的内存 Map 中，key 为 `ip:xxx` 和 `email:xxx`，过期自动清理。服务重启后清零。连续失败锁定持久化到 store.json。

---

## 9. 迁移策略

### 9.1 自动数据迁移

`ensureStoreShape()` 在每次读取 store 时执行，自动完成 v1.0.2 → v2.0 迁移：

| 数据 | 迁移动作 |
|------|---------|
| 现有 user-demo | 补充 email, password_hash(随机), role="admin", status="active", token_version=1 |
| 历史 tasks/results/garments/model_assets/credit_logs | 补充 user_id: "user-demo" |
| 系统模特 | 不变，租户级共享 |
| store 根 | 新增 refresh_token_blacklist: [], admin_audit_logs: [] |

### 9.2 回滚方案

降级回 v1.0.2：将 `req.userId`/`req.tenantId` 恢复为硬编码值，移除 auth 中间件和新增依赖。store.json 保留（新字段不影响旧代码读取）。

---

## 10. 目录结构（v2.0 完整）

```
chuanyi-saas/
├── backend/
│   ├── package.json              # [修改] +jsonwebtoken +bcryptjs
│   ├── .env                      # [修改] +JWT_SECRET（自动生成）
│   ├── .admin-credentials        # [新增] 种子管理员密码（600权限）
│   ├── data/
│   │   └── store.json           # [迁移] 扩展数据模型
│   └── src/
│       ├── server.js             # [修改] JWT_SECRET初始化 + 限流计数器
│       ├── env.js                # 不变
│       ├── auth/
│       │   └── auth.js           # [新增] JWT + bcrypt 核心
│       ├── middleware/
│       │   └── auth.js           # [新增] authRequired + adminRequired
│       ├── routes/
│       │   ├── index.js          # [修改] 认证集成 + 硬编码替换
│       │   └── admin.js          # [新增] 管理员 API
│       ├── services/
│       │   ├── agent.js           # [修改] 移除硬编码 user
│       │   ├── task-runner.js     # [修改] user_id 传递
│       │   └── ... (其他不变)
│       ├── store/
│       │   └── store.js          # [修改] 种子管理员 + 迁移 + 审计
│       ├── ai/
│       └── storage/
│
├── frontend/
│   └── src/
│       ├── index.html            # [修改] +登录页 +用户区 +弹窗
│       ├── app.js                # [修改] +认证状态 +api()拦截器 +修改密码
│       └── styles.css            # [修改] +登录/弹窗/过渡页/错误态样式
│
├── admin/                        # [新增] 独立管理员后台
│   ├── package.json
│   └── src/
│       ├── static-server.js      # 端口 3001
│       ├── index.html            # 登录页 + 过渡页 + 主界面
│       ├── app.js                # 认证 + 用户CRUD + 日志
│       └── styles.css            # 后台样式
│
└── docs/
    ├── prd/
    │   └── AI虚拟人穿衣SaaS_PRD_v2.0_用户系统.md
    └── architecture-v2.0.md      # 本文档
```

---

## 11. 实施计划

| 阶段 | 内容 | 新增文件 | 修改文件 |
|------|------|---------|---------|
| 阶段1 | 后端基础设施：auth.js + middleware + store 迁移 + server.js 限流 | 2 | 2 |
| 阶段2 | 后端 API：admin.js 路由 + routes/index.js 认证集成 | 1 | 2 |
| 阶段3 | 前端改造：登录页 + 拦截器 + 修改密码 + 过渡页 + 错误态 | 0 | 3 |
| 阶段4 | 管理员独立后台：admin/ 完整应用（登录页+过渡页+Tab切换+用户管理+搜索分页+密码安全展示+骨架屏/空态+操作日志） | 4 | 0 |

**依赖关系**：阶段1 → 阶段2 → {阶段3, 阶段4}（阶段3和4可并行）

---

## 12. 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 密码哈希库 | bcryptjs | 纯 JS，无需编译，跨平台 |
| JWT 库 | jsonwebtoken | 生态成熟，API 简洁 |
| 令牌吊销 | token_version + 黑名单结合 | 登出用黑名单（精确），改密/禁用用 token_version（全局、无黑名单膨胀） |
| 限流存储 | 内存 Map | 重启自动清理，避免持久化过期数据 |
| 管理后台部署 | 独立端口 3001 | 开发阶段简单隔离；生产环境通过反向代理统一域名 |
| 密码强度 | v2.0 不做强制策略 | PRD 标记为 v2.0.1 功能 |
| 用户注册 | 仅管理员创建 | PRD 明确要求 |
