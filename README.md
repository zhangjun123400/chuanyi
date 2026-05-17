# AI 虚拟人穿衣 SaaS MVP

这是根据 PRD、架构方案和 UI 设计稿落地的前后端分离可执行工程。

## 项目结构

```text
.
├── backend/                 # Node.js 后端 API，零外部依赖
│   ├── src/server.js
│   └── data/store.json      # 启动后自动生成
├── frontend/                # 浏览器前端工作台
│   └── src/
│       ├── index.html
│       ├── styles.css
│       ├── app.js
│       └── static-server.js
├── database/
│   ├── schema.sql           # PostgreSQL 表结构、索引、枚举
│   ├── seed.sql             # 演示数据
│   └── README.md
├── docs/
│   ├── API.md
│   ├── DEPLOYMENT.md
│   ├── MODEL_INTEGRATION.md
│   └── OSS_SETUP.md
└── 虚拟穿衣SaaS核心功能架构与技术方案.md
```

## 快速启动

启动后端：

```bash
npm start
```

启动前端：

```bash
npm run frontend
```

访问：

```text
http://127.0.0.1:3000
```

## 已实现功能

- 服装图片上传与预检
- 系统模特选择与验证
- Agent 参数推荐
- 图片、30 秒视频、图片+视频任务创建
- 任务状态机模拟流转
- 图片/视频结果卡片
- 质量评分与问题标签
- 额度预扣与流水
- PostgreSQL 建库脚本
- API 文档和部署运行说明
- 模型网关与真实 AI API 接入配置

## 说明

当前版本是可执行 MVP 工程，AI 生成环节用模拟 Worker 完成任务流转和结果生成。接入真实模型时，建议优先替换后端中的任务执行层，保持前端和 API 合同稳定。

模型接入请查看：

```text
docs/MODEL_INTEGRATION.md
```
