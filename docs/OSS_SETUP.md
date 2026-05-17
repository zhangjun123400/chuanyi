# 阿里云 OSS 上传配置

本项目已支持浏览器直传阿里云 OSS：

```text
前端选择图片
→ 后端生成 OSS PUT 签名 URL
→ 前端直传 OSS
→ 后端保存 OSS GET 签名 URL
→ 百炼 AI 试衣读取该 URL
```

## 1. 本地环境变量

```bash
ALIYUN_OSS_REGION=oss-cn-beijing
ALIYUN_OSS_BUCKET=moteshiyi
ALIYUN_OSS_ENDPOINT=https://oss-cn-beijing.aliyuncs.com
ALIYUN_OSS_ACCESS_KEY_ID=你的AccessKeyId
ALIYUN_OSS_ACCESS_KEY_SECRET=你的AccessKeySecret
ALIYUN_OSS_READ_EXPIRES_SECONDS=86400
ALIYUN_OSS_PUBLIC_READ=false
ALIYUN_OSS_ALLOW_OBJECT_ACL=false
ALIYUN_OSS_OBJECT_ACL=public-read
ALIYUN_OSS_PUBLIC_BASE_URL=https://moteshiyi.oss-cn-beijing.aliyuncs.com
```

密钥只写入本地 `.env`，不要提交到代码仓库。

## 2. Bucket CORS

OSS 控制台路径：

```text
OSS → Bucket → 数据安全 → 跨域设置 CORS → 创建规则
```

本地开发建议：

```text
来源 Origin: http://127.0.0.1:3000
允许 Methods: GET, PUT, POST, HEAD
允许 Headers: *
暴露 Headers: ETag
缓存时间: 300
```

正式上线后，把 Origin 改成你的生产域名。

## 3. Bucket 权限

你的 Bucket 如果开启了“禁止 PutObject 时设置 public-read ACL”，需要保持：

```bash
ALIYUN_OSS_PUBLIC_READ=false
ALIYUN_OSS_ALLOW_OBJECT_ACL=false
```

当前代码会上传私有对象，然后生成 24 小时有效的签名 GET URL 给百炼读取。

如果你后续在 OSS 控制台允许对象 ACL，并希望传公开 URL，再改为：

```bash
ALIYUN_OSS_PUBLIC_READ=true
ALIYUN_OSS_ALLOW_OBJECT_ACL=true
```

## 4. 系统模特图片

百炼 AI 试衣必须同时拿到：

- 人物图公网 URL
- 服装图公网 URL

服装图已经走 OSS 上传。系统模特图需要你先上传到 OSS，然后配置：

```bash
SYSTEM_MODEL_EVA_URL=https://...
SYSTEM_MODEL_MIA_URL=https://...
SYSTEM_MODEL_NOAH_URL=https://...
```
