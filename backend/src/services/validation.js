const { isRemoteUrl } = require("./garment");
const { MAX_IMAGE_UPLOAD_BYTES, PROVIDER_MAX_IMAGE_BYTES, PROVIDER_MIN_IMAGE_EDGE, PROVIDER_MAX_IMAGE_EDGE } = require("./constants");

function validateAliyunTryonInputs({ garment, model }) {
  const errors = [];
  if (!garment) errors.push("缺少服装图。");
  if (!model) errors.push("缺少真人模特图，请上传一张正面全身真人照片。");
  if (garment && !isRemoteUrl(garment.file_url)) {
    errors.push("服装图不是公网 HTTP/HTTPS URL，请确认 OSS 上传成功。");
  }
  if (model && !isRemoteUrl(model.file_url || model.preview_url)) {
    errors.push("真人模特图不是公网 HTTP/HTTPS URL，请确认已上传真人模特图且 OSS 上传成功。");
  }
  if (garment?.size_bytes && Number(garment.size_bytes) > MAX_IMAGE_UPLOAD_BYTES) {
    errors.push("服装图超过 20MB 上限，请压缩后重新上传。");
  }
  if (model?.size_bytes && Number(model.size_bytes) > MAX_IMAGE_UPLOAD_BYTES) {
    errors.push("真人模特图超过 20MB 上限，请压缩后重新上传。");
  }
  if (garment?.size_bytes && Number(garment.size_bytes) > PROVIDER_MAX_IMAGE_BYTES) {
    errors.push("服装图未生成模型合规图：当前超过百炼 5MB 限制，请重新上传服装图。");
  }
  if (model?.size_bytes && Number(model.size_bytes) > PROVIDER_MAX_IMAGE_BYTES) {
    errors.push(`模特图未生成模型合规图：当前约 ${Math.round(Number(model.size_bytes) / 1024 / 1024 * 10) / 10}MB，超过百炼 5MB 限制。请到系统模特库点击"修改"，重新上传该模特图。`);
  }
  const gw = Number(garment?.width || 0), gh = Number(garment?.height || 0);
  const mw = Number(model?.width || 0), mh = Number(model?.height || 0);
  if (gw && gh && (Math.max(gw, gh) >= PROVIDER_MAX_IMAGE_EDGE || Math.min(gw, gh) <= PROVIDER_MIN_IMAGE_EDGE)) {
    errors.push("服装图尺寸不符合百炼要求，请重新上传，系统会自动生成模型合规图。");
  }
  if (mw && mh && (Math.max(mw, mh) >= PROVIDER_MAX_IMAGE_EDGE || Math.min(mw, mh) <= PROVIDER_MIN_IMAGE_EDGE)) {
    errors.push("模特图尺寸不符合百炼要求，请在系统模特库中重新上传该模特图。");
  }
  if (garment?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`服装图预检未通过：${garment.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  if (model?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`真人模特图预检未通过：${model.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  if (garment?.requires_full_body && model?.pose_type === "half_body") {
    errors.push(`${garment.category_label || "当前服装"}需要全身模特图，当前选择的是半身模特，容易生成只穿上半身或缺少下摆，请更换正面全身模特照片。`);
  }
  if (/(模特|model|person|真人|人像|全身)/i.test(String(garment?.file_name || ""))) {
    errors.push("服装图文件名像真人/模特图，请检查是否把模特图上传到了服装区域。");
  }
  if (/(衣|裙|裤|上衣|外套|garment|cloth|shirt|dress|pants|coat)/i.test(String(model?.name || ""))) {
    errors.push("真人模特图文件名像服装图，请检查是否把服装图上传到了模特区域。");
  }
  return errors;
}

function validateFashnTryonInputs({ garment, model }) {
  const errors = [];
  if (!garment) errors.push("缺少服装主图。");
  if (!model) errors.push("缺少真人模特图。");
  if (garment && !isRemoteUrl(garment.file_url)) errors.push("服装主图不是公网 HTTP/HTTPS URL，请确认 OSS 上传成功。");
  if (model && !isRemoteUrl(model.file_url || model.preview_url)) errors.push("真人模特图不是公网 HTTP/HTTPS URL，请确认已上传真人模特图且 OSS 上传成功。");
  if (garment?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`服装主图预检未通过：${garment.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  if (model?.risk_flags?.some(item => item.level === "block")) {
    errors.push(`真人模特图预检未通过：${model.risk_flags.filter(item => item.level === "block").map(item => item.message).join("；")}`);
  }
  return errors;
}

function validationFailed(validation) {
  if (!validation) return false;
  if (validation.product_fidelity_passed === false) return true;
  if (validation.color_match === false || validation.shape_length_match === false || validation.detail_texture_match === false) return true;
  if (Number(validation.color_score ?? 1) < 0.72) return true;
  if (Number(validation.shape_length_score ?? 1) < 0.72) return true;
  if (Number(validation.detail_texture_score ?? 1) < 0.72) return true;
  return validation.passed === false && Number(validation.confidence || 0) >= 0.55;
}

function stringifyErrorDetail(value, fallback = "") {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  try { return JSON.stringify(value).slice(0, 1200); } catch { return String(value); }
}

function normalizeProviderError(error) {
  const raw = error?.message && error.message !== "[object Object]"
    ? error.message
    : stringifyErrorDetail(error?.provider_payload || error, String(error || ""));
  const status = Number(error?.status || 0);

  if (/pixazo/i.test(raw) && (status === 401 || status === 403 || /\b(401|403)\b|unauthorized|forbidden|subscription/i.test(raw))) {
    return { code: "PIXAZO_ACCESS_DENIED", userMessage: "Pixazo 试衣接口拒绝访问。", suggestion: "系统已尝试 Pixazo 主网关和备用网关。请在 Pixazo 后台确认这个 API Key 已开通 IDM/DM-VTON 接口权限且余额可用；如果后台显示已开通，再检查传给 Pixazo 的服装图和模特图是否为无登录、无防盗链的公网 URL。", providerMessage: raw };
  }
  if (/pixazo/i.test(raw) && /fetch failed|network failed|getaddrinfo|enotfound|eai_again|dns|network/i.test(raw)) {
    return { code: "PIXAZO_NETWORK_UNREACHABLE", userMessage: "后端无法连接 Pixazo 试衣网关。", suggestion: "系统已尝试 Pixazo 主网关和备用网关；请检查本机网络/DNS 是否能访问 gateway.pixazo.ai 或 gateway.appypie.com。如果国内网络不通，建议暂时切回百炼 AI 试衣 Plus，或让 Pixazo 提供国内可访问的网关域名。", providerMessage: raw };
  }
  if (/302\.AI FASHN|FASHN Try-On/i.test(raw) && /fetch failed|network failed|getaddrinfo|enotfound|eai_again|dns|network/i.test(raw)) {
    return { code: "THREE_O_TWO_FASHN_NETWORK_UNREACHABLE", userMessage: "后端无法连接 302.AI FASHN 试衣接口。", suggestion: "请稍后重试，或临时切换到百炼 AI 试衣 Plus/Pixazo 备选模型。系统已调整为：如果前面已生成过候选图，后续重试网络失败不会再把整单直接打失败。", providerMessage: raw };
  }
  if (/302\.AI FASHN|FASHN Try-On/i.test(raw) && (status === 401 || status === 403 || /\b(401|403)\b|unauthorized|forbidden|access denied|permission/i.test(raw))) {
    return { code: "THREE_O_TWO_FASHN_ACCESS_DENIED", userMessage: "302.AI FASHN 试衣接口拒绝访问。", suggestion: "请检查 302.AI Key 是否仍有效、余额是否可用、账号是否已开通 FASHN Try-On；如果权限正常，再确认上传到 OSS 的模特图和服装图是可公网访问的 URL。", providerMessage: raw };
  }
  if (/input\.category|category must be one of|upper_body|lower_body|dresses/i.test(raw)) {
    return { code: "TRYON_CATEGORY_INVALID", userMessage: "试衣模型品类参数不符合要求。", suggestion: "系统已修正 FASHN 品类映射：上衣 upper_body、下装 lower_body、连衣裙 dresses。请重启后端后重新提交任务。", providerMessage: raw };
  }
  if (status === 402 || /\b402\b|payment required|insufficient.*credit|billing|payment|quota|balance/i.test(raw)) {
    return { code: "PROVIDER_BILLING_OR_QUOTA_REQUIRED", userMessage: "模型供应商账号额度或计费状态不可用。", suggestion: "请检查 Replicate 账号是否已开通计费、余额是否充足、Token 是否属于已开通计费的账号；处理完成后重新提交任务，或先切换回百炼 AI 试衣 Plus。", providerMessage: raw };
  }
  if (/content checker|flagged by a content checker|内容检查器|inappropriate content|data_inspection_failed|sensitive|content/i.test(raw)) {
    const isFashn = /302\.AI FASHN|FASHN Try-On/i.test(raw);
    return { code: "CONTENT_REJECTED", userMessage: `输入图片触发${isFashn ? "302.AI/FASHN" : "模型供应商"}内容安全拦截，未生成。`, suggestion: "请更换更规范的真人模特图和服装图：真人模特建议使用正面全身站姿、非暴露、非内衣/泳装、背景简单；服装图建议使用平铺或假人展示、无真人裸露皮肤、无水印和敏感文字。", providerMessage: raw };
  }
  if (/authorization to access the media resource|access.*media resource|403|forbidden|accessdenied|access denied/i.test(raw)) {
    return { code: "MEDIA_ACCESS_DENIED", userMessage: "百炼无法读取 OSS 图片资源。", suggestion: "请把 OSS 上传对象设置为 public-read，或提供不带签名参数的公网图片 URL；然后重新上传服装图和真人模特图再生成。", providerMessage: raw };
  }
  if (/image resolution is invalid|largest length.*4096|size of image ranges from 5kb to 5mb|5kb to 5mb/i.test(raw)) {
    return { code: "IMAGE_DIMENSION_OR_SIZE_INVALID", userMessage: "输入图片不符合百炼模型尺寸或大小要求。", suggestion: "请重新上传服装图和真人模特图。系统会自动生成 5KB-5MB、最长边小于 4096px、最短边大于 150px 的模型合规图；如果使用旧模特库图片，请在模特库中点击修改并重新上传该模特图。", providerMessage: raw };
  }
  if (/timeout|timed out|aborted|aborterror|operation was aborted/i.test(raw)) {
    return { code: "PROVIDER_ABORTED_OR_TIMEOUT", userMessage: "模型调用被中断或响应超时。", suggestion: "请稍后重试；如果连续出现，可先减少生成张数、暂时关闭最终商用出图，或检查百炼/302.ai 当前响应是否较慢。", providerMessage: raw };
  }
  return { code: "PROVIDER_ERROR", userMessage: "模型供应商返回错误。", suggestion: "请检查输入图片是否清晰、是否符合平台规则；如果连续失败，请切换图片或稍后再试。", providerMessage: raw };
}

module.exports = {
  validateAliyunTryonInputs,
  validateFashnTryonInputs,
  validationFailed,
  stringifyErrorDetail,
  normalizeProviderError
};
