# 数据库搭建说明

本项目本地演示模式默认使用 `backend/data/store.json`，不强制依赖数据库，便于直接运行。正式环境建议使用 PostgreSQL 14+。

## 1. 创建数据库

```bash
createdb virtual_tryon
```

## 2. 初始化表结构

```bash
psql -d virtual_tryon -f database/schema.sql
```

## 3. 写入演示数据

```bash
psql -d virtual_tryon -f database/seed.sql
```

## 4. 推荐连接信息

```bash
DATABASE_URL=postgres://tryon_user:your_password@localhost:5432/virtual_tryon
```

当前后端为零依赖可执行版本，使用 JSON 文件模拟持久化。接入 PostgreSQL 时建议把 `backend/src/server.js` 中的 `readStore/writeStore` 替换为 Repository 层，并按以下边界实现：

- `TenantRepository`
- `UserRepository`
- `AssetRepository`
- `TaskRepository`
- `ResultRepository`
- `CreditRepository`
- `TaskEventRepository`

业务 API、前端页面和任务状态机不需要改动。
