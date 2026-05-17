# 部署和运行指导

## 1. 本地运行

要求：Node.js 18+。

在项目根目录执行：

```bash
npm start
```

后端地址：

```text
http://127.0.0.1:4000
```

另开一个终端启动前端：

```bash
npm run frontend
```

前端地址：

```text
http://127.0.0.1:3000
```

浏览器打开前端地址即可体验完整流程。

## 2. 本地演示数据

后端会自动创建：

```text
backend/data/store.json
```

这份文件保存演示租户、用户额度、任务、结果和额度流水。需要重置演示环境时，停止服务后删除该文件，再重新启动后端。

## 3. PostgreSQL 初始化

```bash
createdb virtual_tryon
psql -d virtual_tryon -f database/schema.sql
psql -d virtual_tryon -f database/seed.sql
```

生产环境建议使用：

```bash
DATABASE_URL=postgres://tryon_user:your_password@db-host:5432/virtual_tryon
```

当前代码为了保证零依赖可执行，默认没有引入数据库驱动。正式接入时，保留 API 和前端不变，把 JSON Store 替换成 PostgreSQL Repository 即可。

## 4. 生产部署建议

前端：

- 静态资源可部署到 Nginx、对象存储静态站点或 CDN。
- 修改 `frontend/src/app.js` 中的 `API_BASE`，指向后端域名。

后端：

- 使用 Node.js 18+ 运行 `backend/src/server.js`。
- 生产环境建议改造成 NestJS/FastAPI 服务，并接入 PostgreSQL、Redis、对象存储和消息队列。
- 图片和视频生成 Worker 建议独立容器部署，避免长任务影响 API。

推荐生产组件：

- PostgreSQL：业务数据、任务、额度流水。
- Redis：任务进度缓存、限流、短期锁。
- 对象存储：服装图、模特图、生成图片和 MP4 视频。
- 队列：Temporal、BullMQ、Celery 或云队列。
- GPU Worker：图片试穿、视频生成、质量检测分队列部署。

## 5. 环境变量

```bash
PORT=4000
FRONTEND_PORT=3000
DATABASE_URL=postgres://...
OBJECT_STORAGE_BUCKET=...
CDN_BASE_URL=...
AI_IMAGE_PROVIDER=mock
AI_VIDEO_PROVIDER=mock
TRYON_IMAGE_API_URL=
TRYON_IMAGE_API_KEY=
RUNWAY_API_KEY=
KLING_ACCESS_KEY=
KLING_SECRET_KEY=
KLING_API_KEY=
LUMA_API_KEY=
```

当前可执行版本实际使用：

- `PORT`
- `FRONTEND_PORT`
- `AI_IMAGE_PROVIDER`
- `AI_VIDEO_PROVIDER`
- `TRYON_IMAGE_API_URL`
- `TRYON_IMAGE_API_KEY`
- `RUNWAY_API_KEY`
- `KLING_ACCESS_KEY`
- `KLING_SECRET_KEY`
- `KLING_API_KEY`
- `LUMA_API_KEY`

其余变量为生产化预留。

模型接入细节见：[MODEL_INTEGRATION.md](./MODEL_INTEGRATION.md)。

## 6. 验证步骤

1. 打开 `http://127.0.0.1:3000`。
2. 上传一张 JPG/PNG/WebP 服装图片。
3. 选择系统模特。
4. 输入用途描述，例如“适合 TikTok 上新的欧美模特短视频”。
5. 点击“生成推荐”。
6. 选择“图片+视频”，提交任务。
7. 等待任务进度到 100%。
8. 查看生成结果、质量标签、问题标签和下载地址。
