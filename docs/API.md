# API 接口说明

后端默认地址：`http://localhost:4000`

## 健康检查

`GET /health`

返回服务状态。

## 系统模特

`GET /v1/models/system`

返回系统模特列表。

## 服装识别与预检

`POST /v1/garments/analyze`

请求示例：

```json
{
  "file": {
    "name": "dress.png",
    "size": 1024000,
    "type": "image/png",
    "data_url": "data:image/png;base64,..."
  },
  "description": "Instagram 新品图"
}
```

返回 `garment_id`、服装品类、风险标签和预检结果。

## 模特验证

`POST /v1/models/validate`

请求示例：

```json
{
  "model_id": "model-eva-001"
}
```

## Agent 推荐

`POST /v1/agent/recommendations`

请求示例：

```json
{
  "garment_id": "garment_xxx",
  "model_id": "model-eva-001",
  "intent": "适合 TikTok 上新的短视频",
  "platform_use": "TikTok短视频"
}
```

## 创建试穿任务

`POST /v1/tryon/tasks`

请求示例：

```json
{
  "garment_id": "garment_xxx",
  "model_id": "model-eva-001",
  "output_type": "image_video",
  "prompt": "欧美模特，干净棚拍",
  "params": {
    "image": {
      "count": 4,
      "ratio": "4:5",
      "background": "干净棚拍",
      "keep_texture": true,
      "quality_filter": true,
      "platform_use": "社媒图"
    },
    "video": {
      "duration_seconds": 15,
      "ratio": "9:16",
      "motion_template": "轻微转身",
      "camera": "中景全身",
      "background": "干净棚拍",
      "audio": "无",
      "consistency": "标准"
    }
  }
}
```

## 查询任务

`GET /v1/tryon/tasks/{id}`

返回任务状态、进度、结果和事件。

## 任务历史

`GET /v1/tryon/tasks`

## 下载结果

`GET /v1/tryon/results/{id}/download`

返回本地演示签名地址。生产环境应返回对象存储短期签名 URL。
