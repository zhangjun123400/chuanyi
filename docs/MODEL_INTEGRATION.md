# 模型接入说明

当前工程已经预留模型网关：

```text
backend/src/ai/model-gateway.js
```

默认配置是 `mock`，没有 API Key 也能正常运行。开通供应商后，只需要填写环境变量并重启后端。

## 1. 图片虚拟试衣 API

图片试衣是商用质量的核心。建议优先开通或自建一个专门的虚拟试衣 API。

环境变量：

```bash
AI_IMAGE_PROVIDER=custom
TRYON_IMAGE_API_URL=https://your-tryon-provider.example.com/v1/tryon
TRYON_IMAGE_API_KEY=sk-xxx
```

当前代码会向该地址发送：

```json
{
  "task_id": "task_xxx",
  "garment": {},
  "model": {},
  "prompt": "用户提示词",
  "params": {},
  "index": 0
}
```

期望返回：

```json
{
  "image_url": "https://cdn.example.com/result.png",
  "model": "your-vton-model",
  "task_id": "provider_task_id"
}
```

可选模型方向：

- 自部署 VTON：CatVTON、StableVITON、商业授权版 IDM-VTON、企业自研模型。
- 第三方商用 VTON API：先用于快速上线和兜底。

注意：部分开源 VTON 权重是非商业授权，不能直接用于收费 SaaS。

### Segmind

当前代码已支持 Segmind 图片虚拟试衣。Segmind 认证使用 `x-api-key` 请求头；本地上传的 data URL 会先通过 Segmind Storage 上传成可访问 URL，再传给试衣模型。

推荐先用 `segfit-v1.3`：

```bash
AI_IMAGE_PROVIDER=segmind
SEGMIND_API_KEY=SG_xxx
SEGMIND_TRYON_MODEL=segfit-v1.3
SEGMIND_MODEL_TYPE=Quality
```

也可以切换到 Try-On Diffusion：

```bash
AI_IMAGE_PROVIDER=segmind
SEGMIND_API_KEY=SG_xxx
SEGMIND_TRYON_MODEL=try-on-diffusion
SEGMIND_NUM_INFERENCE_STEPS=35
SEGMIND_GUIDANCE_SCALE=2
```

需要在 Segmind 开通：

- Serverless API credits
- Segmind Storage
- `segfit-v1.3` 或 `try-on-diffusion` 模型访问权限

官方资料：

- Segmind API 认证使用 `x-api-key` header。
- Segmind Storage endpoint：`POST https://workflows-api.segmind.com/upload-asset`
- SegFit v1.3 endpoint：`POST https://api.segmind.com/v1/segfit-v1.3`
- Try-On Diffusion endpoint：`POST https://api.segmind.com/v1/try-on-diffusion`

### 阿里云百炼 / DashScope AI 试衣

当前代码已支持阿里云百炼 AI 试衣，默认使用 Plus 版 `aitryon-plus`。Plus 版相较基础版在图像清晰度、布料纹理和 Logo 还原方面更好，但生成耗时更长、成本更高。

配置：

```bash
AI_IMAGE_PROVIDER=aliyun
ALIYUN_DASHSCOPE_API_KEY=sk-xxx
ALIYUN_DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com
ALIYUN_TRYON_MODEL=aitryon-plus
ALIYUN_TRYON_RESOLUTION=1280
ALIYUN_TRYON_ENABLE_REFINER=true
ALIYUN_REFINER_MODEL=aitryon-refiner
ALIYUN_PRE_EDIT_ENABLED=true
ALIYUN_PRE_EDIT_MODEL=qwen-image-edit-plus
```

重要限制：

- 文档说明 `aitryon` 和 `aitryon-plus` 仅适用于“中国内地（北京）”地域，需要使用该地域 API Key。
- 模特图和服装图必须是公网可访问的 HTTP/HTTPS URL。
- 本地路径和本地 data URL 不能直接作为输入。
- 任务成功后返回的 `image_url` 有效期有限，当前代码会下载并保存到本地 `backend/data/generated/`。
- 输出分辨率统一配置为 `1280`，对应 720x1280。
- 商业详情图建议开启 `aitryon-refiner`，当前工程默认支持“Plus 试衣图 -> 精修图 -> 本地保存”的链路。

真实生产建议：

1. 上传服装图、模特图到阿里 OSS。
2. 生成可公网访问的短期签名 URL。
3. 调用 DashScope `aitryon-plus`。
4. 轮询任务结果。
5. 下载结果图到自己的对象存储或本地开发目录。

官方接口：

- 创建任务：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/image-synthesis`
- 查询任务：`GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}`
- Header：`Authorization: Bearer $DASHSCOPE_API_KEY`
- Header：`X-DashScope-Async: enable`

如果需要降级到基础版，只需改：

```bash
ALIYUN_TRYON_MODEL=aitryon
```

如果临时不想消耗精修额度：

```bash
ALIYUN_TRYON_ENABLE_REFINER=false
```

### Agent 图改图预处理

当前工程已支持把 Agent 输入用于试衣前的图像预处理：

```text
Agent 输入
→ Qwen-Image-Edit 保守编辑真人图
→ Qwen-Image-Edit 保守编辑服装图
→ aitryon-plus 试衣
→ aitryon-refiner 精修
```

推荐模型：

- `qwen-image-edit-plus`：适合低成本保守图改图，支持多图/单图编辑、自定义分辨率。
- `qwen-image-2.0-pro`：更强的纹理和语义遵循，适合更高质量但成本更高的场景。
- `qwen-image-edit-max`：适合复杂工业设计、几何推理和人物一致性要求更高的场景。

前端已支持用户在任务参数中选择：

```json
{
  "pre_edit": {
    "enabled": true,
    "model": "qwen-image-edit-plus"
  }
}
```

后端优先使用任务里的 `params.pre_edit.model`，如果没有传才使用环境变量 `ALIYUN_PRE_EDIT_MODEL`。

为了尽量保留原始像素，当前默认使用“保守编辑”提示词，只允许：

- 轻微清晰度提升
- 曝光/白平衡校正
- 背景清洁
- 去水印或杂物
- 轻微锐化
- 电商图片质感优化

并明确禁止：

- 改变人物身份、五官、身材比例
- 改变服装款式、版型、颜色、Logo、纽扣、花纹
- 大幅重绘成另一张图

如果发现图改图改变太大，可关闭：

```bash
ALIYUN_PRE_EDIT_ENABLED=false
```

或升级模型：

```bash
ALIYUN_PRE_EDIT_MODEL=qwen-image-2.0-pro
```

## 商业详情图质量建议

要达到服装电商详情图水平，建议把生成链路设为：

```text
高质量真人正面全身图
→ 高质量服装平铺图
→ Qwen-Image-Edit 保守预处理
→ aitryon-plus 生成 720x1280
→ aitryon-refiner 精修
→ 质检筛选
→ 必要时再做超分/锐化/背景统一
```

输入图要求会直接决定上限：

- 真人图不要用二次 AI 图、截图、小红书/抖音水印图。
- 真人图建议原始相机图或高清棚拍，正面全身，脸部清晰。
- 服装图应为无水印平铺图，主体占比大，背景干净。
- 原图模糊、水印、压缩严重时，模型会把这些缺陷带到输出里。

本项目已支持 OSS 签名直传。服装图上传后会保存 OSS 签名读 URL，并交给百炼。系统模特还需要配置真实公网图片：

```bash
SYSTEM_MODEL_EVA_URL=https://your-bucket.oss-cn-beijing.aliyuncs.com/models/eva.jpg?...
SYSTEM_MODEL_MIA_URL=https://your-bucket.oss-cn-beijing.aliyuncs.com/models/mia.jpg?...
SYSTEM_MODEL_NOAH_URL=https://your-bucket.oss-cn-beijing.aliyuncs.com/models/noah.jpg?...
```

如果系统模特 URL 为空，阿里百炼试衣会自动回退到 mock，避免任务失败。

## 2. 视频生成 API

视频建议采用“先生成高质量试穿图，再用图生视频模型生成短视频”的方案。

### Runway

环境变量：

```bash
AI_VIDEO_PROVIDER=runway
RUNWAY_API_KEY=your_key
RUNWAY_API_BASE_URL=https://api.dev.runwayml.com
RUNWAY_VIDEO_MODEL=gen4_turbo
```

需要开通：

- Runway Developer API
- Image to Video 生成权限
- 组织额度 / billing

### Kling / 可灵类 OpenAI-compatible API

当前代码已支持可灵官方 Access Key + Secret Key 的 JWT 认证。后端会生成 30 分钟有效的 Bearer token，不会把 Access/Secret 暴露给浏览器。

```bash
AI_VIDEO_PROVIDER=kling
KLING_ACCESS_KEY=your_access_key
KLING_SECRET_KEY=your_secret_key
KLING_API_BASE_URL=https://api.klingai.com
KLING_IMAGE2VIDEO_PATH=/v1/videos/image2video
KLING_STATUS_PATH_TEMPLATE=/v1/videos/image2video/{task_id}
KLING_VIDEO_MODEL=kling-v1-6
KLING_MODE=std
```

需要开通：

- 图生视频 API
- 任务查询权限
- 商用授权和并发额度

如果你使用的是第三方可灵网关，它只给单个 Bearer API Key，也可以配置：

```bash
AI_VIDEO_PROVIDER=kling
KLING_API_KEY=your_bearer_key
KLING_API_BASE_URL=https://provider.example.com
KLING_IMAGE2VIDEO_PATH=/kling/v1/videos/image2video
KLING_STATUS_PATH_TEMPLATE=/kling/v1/videos/image2video/{task_id}
```

当前实现会：

1. 使用试穿推荐分最高的图片作为图生视频首帧。
2. 提交可灵 image2video 任务。
3. 轮询任务状态。
4. 拿到视频 URL 后下载到本地 `backend/data/generated/`。
5. 前端通过本地 `/v1/media/generated/...` 地址播放/下载。

### Luma

如果服务商提供 OpenAI-compatible video endpoint：

```bash
AI_VIDEO_PROVIDER=luma
LUMA_API_KEY=your_key
LUMA_API_BASE_URL=https://provider.example.com
LUMA_VIDEO_MODEL=ray
```

需要开通：

- Luma API / Dream Machine API
- Image to Video
- 商用输出授权

## 3. 商用必备质检

真实上线时，不建议直接把模型输出交给用户。建议增加：

- 服装纹理一致性检测
- 人脸/人体自然度检测
- 手部、衣摆、领口异常检测
- 视频帧闪烁检测
- 图案漂移检测
- 敏感内容复检

当前工程的 `quality_status` 与 `issue_tags` 已经预留字段，后续替换为真实质检模型输出即可。

## 4. 生产推荐路由

```text
白底商品图 -> 自部署 VTON
社媒图 -> VTON + 背景生成/重绘
复杂图案 -> 高保真 VTON + 增强纹理保持
视频 -> 推荐分最高图片作为首帧 + 图生视频
失败/超时 -> 切备用供应商
```

## 5. 本地运行切换示例

```bash
AI_IMAGE_PROVIDER=custom \
TRYON_IMAGE_API_URL=https://your-provider/v1/tryon \
TRYON_IMAGE_API_KEY=sk-xxx \
AI_VIDEO_PROVIDER=runway \
RUNWAY_API_KEY=sk-xxx \
npm start
```
