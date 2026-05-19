# 产品需求文档 PRD

## AI虚拟人穿衣 SaaS v1.0.2 · 定稿版

**单任务商用品质闭环：从服装上传到可商用图片/视频下载的完整链路**

| 字段 | 内容 |
|------|------|
| 版本 | v1.0.2 定稿版 |
| 基线 | v1.0 图片生成 + v1.0.1 商用品质链路 + v1.1 可用性增强 |
| 负责人 | 多灵 / AI Agent 产品经理 |
| 日期 | 2026-05-18 |
| 定位 | 面向服装商家和内容团队的 AI 虚拟试穿 SaaS，单任务即可产出可商用图片与短视频素材 |
| 范围 | 单任务虚拟试衣（图片 + 最长30秒视频），含完整商用品质链路、多模型供应商、系统模特库、结果管理和模型栈管理 |

---

## 1. 产品定位

v1.0.2 定稿版是 AI 虚拟人穿衣 SaaS 的首个完整商用版本。用户上传一张服装图和选择一个模特，通过 AI Agent 智能推荐参数，系统执行「预检 → 试衣生成 → 商品一致性校验 → 精修 → 高清增强 → 质量评分」的商用品质链路，最终产出质量分级（推荐/可用/待修复/不可用）的图片和最长 30 秒的试穿短视频。

**核心价值主张：** 让服装商家无需实拍，用一张服装图 + 一个虚拟模特即可生成可直接用于电商展示的商品图与短视频。

**产品边界：** 本版本覆盖单任务虚拟试衣闭环，不覆盖批量生产、项目/SKU管理、团队协作、开放API。

**数据验证：** 截至定稿日期，系统已生产环境运行，累计处理 73 个任务，产出 51 个结果，管理 74 个服装资产和 29 个模特资产。

---

## 2. 目标用户与场景

| 角色 | 核心诉求 | 典型任务 | 优先级 |
|------|---------|---------|--------|
| 服装电商运营 | 快速生成统一风格商品图 | 同一件连衣裙用 Luna 模特生成 4 张商品图和 1 条短视频 | P0 |
| 品牌内容运营 | 统一品牌视觉，减少拍摄成本 | 同系列商品使用固定模特与背景模板 | P0 |
| 跨境电商卖家 | 快速生成欧美模特商品图 | 上传连衣裙生成 Amazon 商品图和 TikTok 短视频 | P0 |
| 设计打样人员 | 预览版型上身效果 | 设计稿或平铺图生成试穿预览 | P2 |

---

## 3. 核心业务流程

```
用户进入智能试穿工作台
  → 输入需求描述（可选），Agent 推荐参数
  → 上传服装图（JPG/PNG/WebP，≤20MB），系统自动品类识别与预检
  → 选择模特（系统模特库或上传真人图）
  → 品质预检（阻断/风险分级提示）
  → 确认参数（生成数量、画幅、背景、试衣模型、品质链路、输出类型等）
  → 提交任务，预扣额度
  → 系统执行商用品质链路：
      试衣生成 → 商品一致性校验（自动重试最多3次）→ 试衣图精修 → 最终商用出图 → 品质评分
  → 结果按质量分级展示（推荐/可用/待修复/不可用）
  → 达到门槛的图片可下载，推荐/可用图可转视频
```

---

## 4. 功能清单

### 4.1 智能试穿工作台（主操作页）

#### 4.1.1 生成方案（AI Agent）

| 能力 | 说明 |
|------|------|
| 自然语言输入 | 用户用中文描述用途，如「适合 TikTok 上新的欧美模特短视频，同时生成商品图，需要街拍风格背景」 |
| 平台快捷选择 | 商品图 / TikTok短视频 / Instagram / 详情页图 / Amazon |
| Agent 参数推荐 | 根据服装品类、模特姿态、平台用途自动推荐：输出类型、图片数量、画幅、背景、视频时长/比例/动作模板、风险提示 |
| 额度预估 | 提交前展示预计消耗额度 |

#### 4.1.2 上传素材

| 能力 | 说明 |
|------|------|
| 服装主图上传 | 拖拽或点击上传，支持 JPG/PNG/WebP，≤20MB |
| 服装细节参考图 | 支持上传最多 10 张补充图（背面、Logo、印花、面料等） |
| 品类自动识别 | 上传后调用 GPT-4o-mini Vision 模型识别品类，24个品类覆盖；置信度≥55%自动采用，低于阈值用文件名/描述兜底 |
| 品类人工确认 | 上传后展示系统识别结果，用户可在提交前修正品类 |
| 真人/模特图上传 | 支持上传自有模特图，系统自动做人物检测 |
| 系统模特快速选择 | 从模特库一键选择，展示模特预览卡 |
| 服装图预检 | 格式校验、大小校验、清晰度检测、主体完整性检测、敏感内容检测 |
| 图片自动合规转换 | 前端 Canvas 自动将原始图转换为模型要求：最长边≤3072px，最短边≥151px，≤5MB JPEG |

#### 4.1.3 品质预检 Preflight

| 检查项 | 状态分级 | 规则 |
|--------|---------|------|
| 服装品类识别 | 通过 | 系统识别 + 用户可修正 |
| 模特姿态检测 | 通过/风险 | 全身/半身/侧身适配性检查 |
| 图片分辨率 | 通过/风险 | 长边 ≥ 1024px |
| 背景复杂度 | 通过/风险 | 影响生成成功率 |
| 格式与大小 | 阻断/通过 | 非 JPG/PNG/WebP 阻断，>20MB 阻断 |
| 敏感内容 | 阻断/通过 | 违规内容阻断 |

**交互规则：** 阻断项禁止提交，风险项允许继续但需确认，系统展示风险原因和处理建议。

#### 4.1.4 参数确认

| 参数组 | 参数 | 默认值 | 可选项 |
|--------|------|--------|--------|
| 图片 | 生成数量 | 4 | 1/2/4/6/8 |
| 图片 | 画幅 | 1:1 | 1:1 / 4:5 / 3:4 / 9:16 |
| 图片 | 背景 | 干净棚拍 | 白底 / 浅灰 / 室内 / 街拍 / 纯色 |
| 图片 | 试衣模型 | Pixelcut Try-On（当前主测） | GPT-Image 直接试衣 / Pixelcut Try-On / 302.AI FASHN Try-On / 百炼 AI 试衣 Plus / Pixazo Fashn VTON / Replicate IDM-VTON（按 .env 配置可用性） |
| 图片 | 品质链路 | 商用品质 | 快速预览 / 商用品质 / 商拍增强 |
| 图片 | 出图模型 | gpt-image-1.5 | gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini |
| 图片 | 质量筛选 | 开启 | 开启 / 关闭 |
| 图片 | 试衣前图改图 | 关闭 | 三档可选：qwen-image-edit-plus(轻量) / qwen-image-2.0-pro(高质量) / qwen-image-edit-max(最强一致性) |
| 图片 | 试衣图精修 | 关闭 | 开启 / 关闭 |
| 图片 | 最终商用出图 | 开启 | 开启 / 关闭 |
| 图片 | 最终出图要求 | 预设商品一致性提示词 | 可自定义 |
| 视频 | 时长 | 15秒 | 6 / 10 / 15 / 30 |
| 视频 | 比例 | 9:16 | 9:16 / 4:5 / 1:1 / 16:9 |
| 视频 | 动作模板 | 轻微转身 | 静态镜头 / 轻微转身 / 慢走展示 / 上半身展示 |
| 视频 | 帧一致性 | 标准 | 标准 / 增强 |
| 输出 | 输出类型 | 图片 | 图片 / 30秒视频 / 图片+视频 |

**Agent 推荐锁定机制：** 试衣前图改图关闭时，Agent 推荐参数默认锁定不可编辑，避免运营要求影响服装原图一致性。开启试衣前图改图后解锁。

#### 4.1.5 任务摘要面板

- 提交前最终确认：服装品类、模特来源、输出类型、预计生成数、品质链路、预估额度
- 提交按钮在素材未就绪时 disabled
- 提交后预扣额度，失败按规则返还

---

### 4.2 任务进度

#### 4.2.1 多任务并发展示

| 能力 | 说明 |
|------|------|
| 任务列表 | 所有进行中任务以卡片列表展示，显示任务ID、状态、当前阶段、进度% |
| 点击切换 | 点击任一任务卡片，主区域切换为该任务详情 |
| 自动选中 | 默认选中第一个进行中任务 |
| 3秒轮询 | 前端每3秒拉取一次任务状态更新 |

#### 4.2.2 任务详情（图片任务品质管线）

```
上传预检 → 图像预处理 → 试衣生成 → 质量评分 → 精修复 → 质检分≥75 → 高清出图
```

**完整阶段序列：**

| 阶段 | 进度% | 说明 |
|------|-------|------|
| pending | 5% | 任务已提交，等待队列 |
| prechecking | 12% | 生成前质量预检 |
| pre_editing | 22% | 试衣前素材改图（如开启） |
| virtual_tryon | 42% | 虚拟试衣中 |
| tryon_refining | 62% | 试衣图精修（如开启） |
| effect_validating | 76% | 商品一致性校验 |
| gpt_image_optimizing | 88% | 最终商用出图 |
| quality_scoring | 96% | 商用品质评分 |
| completed | 100% | 生成完成 |

**视频任务阶段：** pending → prechecking → generating_keyframes → rendering_video → frame_checking → encoding → completed

**GPT-Image 直接试衣：** 跳过 pre_editing、tryon_refining、gpt_image_optimizing 步骤（直接端到端生成）。

#### 4.2.3 管线可视化

- 管线步骤条：已完成(绿色✓)、进行中(蓝色⟳)、失败(红色✕)、待执行(灰色)
- 失败步骤后所有步骤置灰
- 执行时间线：按时间顺序展示每步骤实际执行时间点和消息
- 进度环形图：SVG 环形进度条 + 百分比 + 当前阶段名称

#### 4.2.4 失败处理

- 失败步骤标红，展示具体失败原因（含分类错误码）
- 提供「重新提交」和「更换服装图」快捷操作
- 失败时预扣额度自动返还

#### 4.2.5 任务取消

- 进行中任务可通过「取消任务」按钮取消
- 取消后预扣额度全额返还
- 已完成/已失败/已取消的任务不可再次取消

---

### 4.3 历史任务

#### 4.3.1 任务列表

| 能力 | 说明 |
|------|------|
| 列表展示 | 按时间倒序，展示任务ID、描述、状态、时间、消耗额度、复选框 |
| 状态筛选 | 全部 / 已完成 / 生成中 / 失败 / 已取消 |
| 搜索 | 按任务 ID 精确搜索 |
| 批量删除 | 勾选多个任务后批量删除 |
| 手动刷新 | 刷新按钮 |

#### 4.3.2 展开详情

- 点击任务行展开详情区域（第二次点击收起）
- 展示：服装品类、模特、试衣模型、品质链路、生成结果统计（推荐/可用/待修复）、耗时
- 快捷操作：查看结果、重新生成

#### 4.3.3 任务删除

- 单个删除或批量删除
- 删除时同步清理关联结果数据和本地生成文件

---

### 4.4 结果管理

#### 4.4.1 结果列表

| 能力 | 说明 |
|------|------|
| 统计卡片 | 生成结果总数 / 推荐 / 可用 / 待修复 数量 |
| 质量筛选 | 全部 / 推荐 / 可用 / 待修复 / 不可用 |
| 结果卡片 | 缩略图、任务ID、时间、质量等级标签 |
| 选中态 | 点击卡片选中并预览大图 |
| 全选/批量操作 | 全选当前筛选结果，批量下载或删除选中 |
| 手动刷新 | 刷新按钮 |

#### 4.4.2 质量分级体系

| 等级 | 定义 | 阈值 | 可用操作 |
|------|------|------|---------|
| 推荐 (recommended) | 自然度、一致性、清晰度均达标，可商用 | 综合分 ≥ 80 且各维度 ≥ 70 | 预览、高清下载、转视频 |
| 可用 (usable) | 轻微瑕疵但不影响基础商品展示 | 综合分 ≥ 70 | 预览、下载、转视频 |
| 待修复 (repair_needed) | 局部问题明显，有修复价值 | 综合分 ≥ 55 | 查看问题、重新生成 |
| 不可用 (unusable) | 严重变形、低清、穿帮或商品失真 | 综合分 < 55 | 查看原因、重新生成 |

**商业等级映射：** S级(≥90)、A级(≥80)、B级(≥70)、C级(≥55)、D级(<55)

**质量评分维度（五维加权）：**

| 维度 | 权重 | 检测内容 |
|------|------|---------|
| 服装自然度 | 35% | 衣领、袖口、腰线、裙摆、裤腿是否变形 |
| 服装一致性 | 30% | 颜色、图案、纹理、版型、长度是否与输入服装一致 |
| 清晰度 | 20% | 分辨率、模糊程度、边缘清晰度、纹理细节 |
| 人体自然度 | 10% | 手、腿、肩颈、躯干是否穿帮 |
| 背景质量 | 5% | 背景污染、主体居中、边缘残影 |

**加减分因子：** 试衣模型品牌加分、精修加分、商拍增强加分、风险标签扣分、重试耗尽扣分、最终出图失败降级。

#### 4.4.3 下载控制

- 仅推荐/可用结果允许下载
- 待修复/不可用结果下载被拒绝（HTTP 409 + 可读提示）
- 下载链接含有效期

---

### 4.5 系统模特库

#### 4.5.1 模特列表

| 能力 | 说明 |
|------|------|
| 卡片网格 | 展示所有模特，含预览图、名称、性别、体型、姿态、适用品类标签、风险标签 |
| 筛选 | 按性别（全部/女/男/不限）、体型（全部/slim/regular/athletic/plus_size）、姿态（全部/全身站立/半身/走动/侧身） |
| 系统模特 | Eva（欧美全身站姿 slim）、Mia（亚洲棚拍半身 regular）、Noah（男装慢走 athletic） |
| 自定义模特 | 支持上传新增、编辑、移除 |

#### 4.5.2 模特编辑表单

| 字段 | 说明 |
|------|------|
| 模特图片 | 上传 JPG/PNG/WebP |
| 名称 | 如「Luna 亚洲全身站姿」 |
| 性别 | 女模特 / 男模特 / 不限 |
| 体型 | slim / regular / athletic / plus_size |
| 姿态 | full_body_standing / half_body / walking / side_view |
| 适用品类 | 逗号分隔，如 dress, coat, pants, shirt |
| 风险标签 | 逗号分隔，如「半身姿态, 手臂遮挡」 |

#### 4.5.3 业务规则

- 移除模特前检查是否有处理中任务引用，有则阻止移除（HTTP 409）
- 至少保留一个可用模特，不可全部移除
- 新增模特需上传模特图片
- 系统模特编辑通过 model_library_changes 机制记录变更，不直接修改内置定义

---

### 4.6 模型与版本管理

#### 4.6.1 四分类模型栈

| 分类 | 包含模型 | 颜色标识 |
|------|---------|---------|
| 试衣模型 (6个) | GPT-Image 直接试衣、Pixelcut Try-On（当前主测）、302.AI FASHN Try-On v1.5、百炼 AI 试衣 Plus、Pixazo Fashn VTON、Replicate IDM-VTON | 品牌蓝 |
| 图改图模型 (3个) | qwen-image-edit-plus、qwen-image-2.0-pro、qwen-image-edit-max | 靛蓝 |
| 出图模型 (3个) | gpt-image-1.5、gpt-image-1、gpt-image-1-mini | 绿色 |
| 预检与辅助 (4个) | 服装品类识别(gpt-4o-mini)、试衣生效质检(gpt-4o)、最终商用出图、图生视频(Kling) | 黄色 |

#### 4.6.2 左侧分类导航 + 右侧模型卡片

- 子导航：四分类按钮 + 已启用数/总数统计 + 启用率进度条
- 模型卡片：名称、供应商、模型版本、用途说明、启用状态标签（启用/未启用/当前主测）、toggle 开关（只读）
- 点击分类切换对应内容

---

### 4.7 统计看板

**工作台顶部统计卡片：**

| 指标 | 说明 |
|------|------|
| 本月任务数 | 当月创建的全部任务数，含环比变化 |
| 生成成功率 | 已完成任务中 completed 和 partial_failed 占比 |
| 可用额度 | 当前账户剩余额度，含本月已用 |
| 进行中任务 | 当前未结束的任务数，可点击跳转进度页 |

**结果管理页统计卡片：** 生成结果总数 / 推荐(质量分≥85) / 可用(75-84) / 待修复(60-74)

---

### 4.8 额度系统

| 能力 | 说明 |
|------|------|
| 余额查询 | GET /v1/credits/balance，初始额度 1200 |
| 预扣 | 任务提交时按生成数量×单价预扣 |
| 计价 | 图片：每张 8 credits（GPT-Image 直接试衣每张 14）；视频：duration × 6 credits |
| 返还 | 任务取消时全额退还未使用额度；失败后自动返还 |
| 流水 | GET /v1/credits/logs，按时间倒序，记录方向/原因/状态 |

---

## 5. 技术实现架构

### 5.1 后端

| 组件 | 技术方案 | 位置 |
|------|---------|------|
| HTTP 服务 | Node.js 原生 http 模块 | backend/src/server.js |
| 路由处理 | 手动 URL 匹配 + 请求体 JSON 解析 | backend/src/routes/index.js |
| 数据存储 | 单 JSON 文件持久化 (store.json) + Promise 互斥锁 | backend/src/store/store.js |
| 任务调度 | setTimeout 模拟阶段推进 | backend/src/services/task-runner.js |
| 图片存储 | 阿里云 OSS（生产）+ 本地文件系统（demo 兜底） | backend/src/storage/oss.js |
| 服装识别 | 文件名规则推断 + GPT-4o-mini Vision 分类器 | backend/src/services/garment.js |
| 质量评分 | 五维加权算法 + 加减分规则引擎 | backend/src/services/quality.js |
| 参数推荐 | 基于品类/平台/意图的规则匹配 | backend/src/services/agent.js |
| 输入校验 | 百炼/302.AI 各自的格式/大小/URL要求校验 | backend/src/services/validation.js |
| AI 模型调用 | 多供应商网关（百炼/OpenAI/Pixelcut/302.AI/Pixazo/Replicate/Kling） | backend/src/ai/model-gateway.js |
| 图片上传常量 | 上传/提供方限制统一管理 | backend/src/services/constants.js |

### 5.2 前端

| 组件 | 技术方案 | 位置 |
|------|---------|------|
| 框架 | 原生 JavaScript (Vanilla JS)，零框架依赖 | frontend/src/app.js |
| 样式 | 原生 CSS + CSS Variables 设计令牌体系 | frontend/src/styles.css |
| 页面结构 | 单页 HTML，tab 切换 | frontend/src/index.html |
| 状态管理 | 全局 state 对象 + DOM 直接同步 | app.js 顶部 |
| 图片处理 | Canvas API 客户端合规转换（尺寸/格式/压缩） | app.js normalizeImageForProvider() |
| 轮询 | setInterval 3s 拉取任务和进度状态 | app.js |
| 静态服务 | Node.js 原生 http 静态文件服务器 | frontend/src/static-server.js |

### 5.3 AI 模型供应商矩阵

| 环节 | 供应商 | 模型 | 用途 |
|------|--------|------|------|
| 服装品类识别 | OpenAI | gpt-4o-mini (Vision) | 品类/颜色/版型/风险识别 |
| 试衣生成（主力） | Pixelcut | Try-On API | 核心虚拟试衣 |
| 试衣生成（备选） | 阿里云百炼 | AI 试衣 Plus | 国内电商场景 |
| 试衣生成（备选） | 302.AI | FASHN Try-On v1.5 | 国际电商场景 |
| 试衣生成（备选） | Pixazo | Fashn VTON | 中转备用 |
| 试衣生成（实验） | Replicate | IDM-VTON | 实验对比 |
| 试衣生成（实验） | OpenAI | GPT-Image 1.5 直接试衣 | 端到端免中间模型 |
| 试衣前图改图 | 阿里云百炼 | Qwen Image Edit | 背景清洁/去水印/调色 |
| 试衣图精修 | 阿里云百炼 | AI 试衣精修 | 融合度优化 |
| 试衣效果验证 | OpenAI | gpt-4o (Vision) | 商品一致性三维度校验 |
| 最终商用出图 | OpenAI | GPT-Image 1.5 | 高清增强/细节提升 |
| 图生视频 | 可灵 Kling | kling-v1/v1-6 | 最长30秒短视频 |

### 5.4 商品一致性自动重试

```
试衣生成 → GPT-4o 校验（颜色/版型长度/纹理各维度≥72%）
  若未通过 → 带反馈自动重试（最多3次）
    第1次重试：修正颜色和版型
    第2次重试：修正纹理细节
    第3次重试：综合修正
  重试耗尽 → 保留最后候选图，标记不可用
  校验通过 → 继续执行精修和最终出图
最终出图后再校验 → 若不通过则回退到试衣精修图
```

---

## 6. 页面清单

| 页面 | 类型 | 核心内容 |
|------|------|---------|
| 智能试穿工作台 | 主操作页 | 生成方案、上传素材（服装+模特）、品质预检、参数确认、任务摘要 |
| 任务进度 | 实时监控 | 多任务列表、管线步骤条、进度环形图、执行时间线、任务信息侧栏 |
| 历史任务 | 列表+详情 | 任务列表（筛选/搜索/批量删除）、点击展开详情、快捷操作 |
| 结果管理 | 素材管理 | 质量分级统计、结果网格（分类筛选）、大图预览、批量操作 |
| 系统模特库 | 资产管理 | 模特卡片网格、多条件筛选、编辑表单 |
| 模型与版本管理 | 配置展示 | 四分类子导航、模型详细卡片 |

---

## 7. 数据结构

### 7.1 store.json 顶层

```json
{
  "tenants": [{ "id", "name", "plan" }],
  "users": [{ "id", "tenant_id", "name", "credit_balance" }],
  "garments": [],
  "model_assets": [],
  "model_library_changes": [],
  "tasks": [],
  "results": [],
  "credit_logs": [],
  "events": [],
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

### 7.2 核心对象字段

**Garment（服装资产）**
`id, tenant_id, user_id, file_name, file_url, preview_url, size_bytes, mime_type, object_key, category, category_label, category_key, tryon_slot, requires_full_body, color, material, pattern, length, risk_flags[], analysis{clarity, subject_integrity, sensitive_content, category_source, category_confidence, category_reason, category_model, fashn_input_risk, ...}, created_at`

**ModelAsset（模特资产）**
`id, name, source(system/user_upload/library_upload), gender, age_range, skin_tone, body_type, pose_type, categories[], preview_color, file_url, preview_url, risk_flags[], risk_tags[], description, video_enabled, tenant_id, user_id, created_at, updated_at, deleted_at`

**Task（生成任务）**
`id, garment_id, model_id, output_type(image/video/image_video), prompt, params{image{}, video{}, quality_strategy, pre_edit{}, refiner{}, post_optimize{}, garment_references[]}, status, progress, current_stage, message, credit_cost, failure_reason, failure_detail, commercial_status, quality_summary{commercial_passed, recommended_count, usable_count, repair_needed_count, unusable_count, best_score}, stage_timings{}, completed_at, created_at, updated_at`

**Result（生成结果）**
`id, task_id, media_type(image/video), image_url, video_url, cover_url, duration_seconds, score, quality_status(recommended/usable/repair_needed/unusable), issue_tags[], quality_report{overall_score, garment_naturalness, garment_consistency, clarity, body_integrity, background_quality, color_match, shape_length_match, detail_texture_match, product_fidelity_passed, product_fidelity_attempts, commercial_grade, decision}, hd_status, download_allowed, model_meta{}, created_at`

**Event（事件日志）**
`id, task_id, status, progress, message, created_at`

**CreditLog（额度流水）**
`id, tenant_id, user_id, task_id, amount, direction(debit/credit), reason(precharge/refund/settle), status(reserved/settled/refunded), created_at`

---

## 8. API 接口

### 8.1 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /health | 健康检查 |
| GET | /v1/system/capabilities | 系统能力清单：模型列表、启用状态、质量策略配置 |
| GET | /v1/stats | 统计数据：本月任务数、成功率、可用额度、进行中任务、本月已用额度 |

### 8.2 模特管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /v1/models/system | 模特库完整列表（系统+自定义+变更覆盖） |
| POST | /v1/models/system | 新增自定义模特 |
| PUT | /v1/models/system/:id | 编辑模特信息和展示状态 |
| DELETE | /v1/models/system/:id | 移除模特（检查进行中任务引用） |
| POST | /v1/models/validate | 校验模特可用性（人物/姿态/敏感内容检测） |

### 8.3 服装管理

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /v1/garments/analyze | 上传并分析服装图（视觉分类器 + 预检） |
| PUT | /v1/garments/:id/category | 人工修正服装品类 |

### 8.4 Agent 推荐

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /v1/agent/recommendations | 生成推荐参数（输出类型/图片/视频/风险提示） |

### 8.5 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /v1/tryon/tasks | 创建试衣任务（校验模型可用性 + 额度预扣） |
| GET | /v1/tryon/tasks | 查询全部任务（含关联 results） |
| GET | /v1/tryon/tasks/:id | 查询任务详情（含 results + events） |
| DELETE | /v1/tryon/tasks/:id | 删除任务（同步清理结果文件和额度流水） |
| POST | /v1/tryon/tasks/:id/cancel | 取消进行中任务并退还额度 |

### 8.6 结果

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /v1/tryon/results | 查询全部结果（含 task 摘要信息） |
| GET | /v1/tryon/results/:id/download | 获取下载链接（质量门槛校验） |
| DELETE | /v1/tryon/results/:id | 删除单个结果 |
| POST | /v1/tryon/results/batch-delete | 批量删除结果 |

### 8.7 额度

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /v1/credits/balance | 当前余额 |
| GET | /v1/credits/logs | 额度流水记录 |

### 8.8 文件

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /v1/assets/upload-token | 获取 OSS 上传凭证 |
| POST | /v1/assets/upload-data-url | 通过 data URL 上传（带合规转换） |
| GET | /v1/media/uploads/:file | 本地开发文件访问 |
| GET | /v1/media/models/:file | 本地模特文件访问 |
| GET | /v1/media/generated/:file | 本地生成结果文件访问 |

---

## 9. 设计规范

### 9.1 设计令牌 (Design Tokens)

| 类别 | 值 |
|------|-----|
| 品牌色 | #2D6CF6（主色）、#1E54D4（hover） |
| 成功 | #16C47F |
| 警告 | #F59E0B |
| 危险 | #EF4444 |
| 信息 | #6366F1 |
| 中性色 | #F8FAFC(50) → #F1F5F9(100) → #E2E8F0(200) → #CBD5E1(300) → #94A3B8(400) → #64748B(500) → #475569(600) → #334155(700) → #1E293B(800) → #0F172A(900) |
| 侧边栏 | bg #0B1120 / hover #1A2744 / active #1E3A6E / text #94A3B8 / textActive #FFFFFF |
| 字体 | -apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei |
| 等宽字体 | SF Mono, Fira Code, Cascadia Code |
| 圆角 | 6px(sm) / 10px(md) / 14px(lg) / 20px(xl) |
| 阴影 | xs(1px) / sm(3px) / md(6px) / lg(15px) / xl(25px)，五级抬升 |
| 过渡 | 150ms(fast) / 250ms(normal) / 400ms(slow)，cubic-bezier(.4,0,.2,1) |

### 9.2 布局

- 侧边栏：240px 固定，sticky 置顶，深色背景
- 主区域：flex 1 自适应
- 工作流布局：1fr 340px（≤1200px 变为单栏）
- 统计卡片：4列（≤1200px 变为 2列）
- 结果网格：自适应最小 220px
- 模特卡片：自适应最小 260px

### 9.3 关键 UX 模式

- **按钮层级：** Primary(蓝底白字) > Secondary(白底灰框) > Ghost(透明) > Danger(红底)
- **Badge 语义：** 成功绿/警告黄/危险红/信息蓝/灰色待处理
- **Chip 筛选：** 默认灰底，选中蓝底蓝字
- **Toggle 开关：** 灰底圆点 → 蓝底圆点右移
- **管线步骤：** done(绿✓) → active(蓝⟳) → pending(灰) → fail(红✕)
- **时间线：** 左侧竖线+圆点，active(蓝+光圈)/done(绿)/fail(红)
- **空状态：** 居中灰色图标+标题+描述文案
- **Toast：** 底部居中，2.6秒自动消失

---

## 10. 验收标准

### 10.1 核心闭环

| 场景 | 验收条件 |
|------|---------|
| 首次生成成功 | 用户从上传到下载完成一次完整试衣生成 |
| 至少1张推荐图 | 每次4张候选的任务至少产出1张推荐 |
| 任务取消返还 | 取消进行中任务，额度正确全额返还 |
| 额度不足拦截 | 余额不足时阻止提交，展示明确提示 |
| 下载门槛 | 待修复/不可用结果无法下载（HTTP 409 + 中文提示） |

### 10.2 品质指标

| 指标 | 目标值 |
|------|--------|
| 每任务至少1张推荐图成功率 | ≥ 80% |
| 服装自然度通过率 | ≥ 70% |
| 高清可商用率 | ≥ 50% |
| 严重变形率 | ≤ 15% |
| 商品一致性重试后通过率 | ≥ 60% |

### 10.3 体验指标

| 指标 | 目标值 |
|------|--------|
| Agent 推荐采纳率 | ≥ 50% |
| 提交前检查理解率 | ≥ 80% |
| 历史任务详情打开率 | ≥ 50% |
| 下载转化率 | ≥ 25% |

---

## 11. 版本演进关系

```
v1.0      — 核心虚拟穿衣闭环（图片 + 30秒视频）
v1.0.1    — 商用品质链路（多候选/五维评分/四级分级/高清门槛）
v1.1      — 可用性增强（智能体主入口/两段式推荐/预检模块/任务详情/结果管理）
v1.0.2    — 定稿版（整合上述全部 + 多模型供应商 + 商品一致性自动重试 + 模型栈管理）
v2.0      — 批量商用生产工作台（后续）: 项目/SKU管理、批量上传、批量生成、参数模板、生产看板
```

---

## 附录

### A. 服装品类覆盖（24类）

| 部位 | 品类 |
|------|------|
| 上半身内搭 | 吊带/背心、打底衫、T恤、衬衫/上衣、针织衫/毛衣、卫衣 |
| 上半身外套 | 夹克/牛仔外套/皮衣、风衣/大衣、羽绒服、西装/开衫 |
| 下半身 | 半身裙、短裤、长裤/裤装、阔腿裤/喇叭裤、紧身裤/瑜伽裤 |
| 连身一体 | 连衣裙、连体裤/连体衣、连身泳衣 |
| 特殊品类 | 睡衣/家居服、内衣/塑身衣、运动上衣/冲锋衣/防晒衣、婚纱/礼服、汉服/旗袍/和服、围裙/实验服/雨衣 |

### B. 服装 Taxonomy 评估维度

| 维度 | 分类 | 影响 |
|------|------|------|
| 品类 | T恤/衬衫/连衣裙/半裙/裤装/外套/特殊 | 决定模特姿态和可穿衣区域 |
| 结构感 | 高结构/低结构 | 西装、羽绒服对肩线和体积更敏感 |
| 垂坠感 | 硬挺/柔软/垂坠 | 长裙、丝质面料裙摆更容易变形 |
| 图案复杂度 | 纯色/轻图案/复杂印花/条纹格纹 | 决定一致性检测严格度和风险提示 |
| 遮挡风险 | 无/轻/重 | 遮蔽严重的不进入生成或需强提示 |

### C. 错误码体系

| 错误码 | 场景 | HTTP |
|--------|------|------|
| INSUFFICIENT_CREDITS | 额度不足 | 402 |
| GARMENT_REFERENCE_LIMIT_EXCEEDED | 细节参考图超10张 | 422 |
| ALIYUN_TRYON_INPUT_INVALID | 百炼输入校验失败 | 422 |
| FASHN_INPUT_INVALID | 302.AI 输入校验失败 | 422 |
| PIXELCUT_TOKEN_MISSING | 未配置 Pixelcut Key | 422 |
| THREE_O_TWO_TOKEN_MISSING | 未配置 302.AI Key | 422 |
| PIXAZO_TOKEN_MISSING | 未配置 Pixazo Key | 422 |
| REPLICATE_TOKEN_MISSING | 未配置 Replicate Token | 422 |
| GPT_IMAGE_TRYON_DISABLED | GPT-Image 试衣未启用 | 422 |
| MODEL_IN_USE | 模特有进行中任务 | 409 |
| LAST_MODEL_NOT_REMOVABLE | 最后一个模特不可删 | 409 |
| TASK_NOT_CANCELLABLE | 任务已结束不可取消 | 409 |
| RESULT_NOT_DOWNLOADABLE | 未达下载门槛 | 409 |
| NOT_FOUND | 资源不存在 | 404 |
| PROVIDER_ERROR | 模型供应商错误 | 502 |
| CONTENT_REJECTED | 内容审核拦截 | 502 |
