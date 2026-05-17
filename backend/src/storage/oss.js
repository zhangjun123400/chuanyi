const crypto = require("crypto");
const path = require("path");

function requiredConfig() {
  const bucket = process.env.ALIYUN_OSS_BUCKET;
  const endpoint = process.env.ALIYUN_OSS_ENDPOINT;
  const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  if (!bucket || !endpoint || !accessKeyId || !accessKeySecret) return null;
  return {
    bucket,
    endpoint: endpoint.replace(/\/$/, ""),
    accessKeyId,
    accessKeySecret
  };
}

function extensionFromName(fileName, contentType) {
  const ext = path.extname(fileName || "").toLowerCase();
  if (ext) return ext;
  if (contentType === "image/png") return ".png";
  if (contentType === "image/webp") return ".webp";
  if (contentType === "image/jpeg") return ".jpg";
  return ".bin";
}

function encodeObjectKey(objectKey) {
  return objectKey.split("/").map(part => encodeURIComponent(part)).join("/");
}

function canonicalOssHeaders(headers = {}) {
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase().startsWith("x-oss-"))
    .map(([key, value]) => [key.toLowerCase().trim(), String(value).trim()])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
}

function sign({ method, bucket, objectKey, expires, contentType = "", accessKeySecret, ossHeaders = {} }) {
  const canonicalizedResource = `/${bucket}/${objectKey}`;
  const stringToSign = `${method}\n\n${contentType}\n${expires}\n${canonicalOssHeaders(ossHeaders)}${canonicalizedResource}`;
  return crypto.createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
}

function ossHost(config) {
  return config.endpoint
    .replace("https://", `https://${config.bucket}.`)
    .replace("http://", `http://${config.bucket}.`);
}

function publicUrl(config, objectKey) {
  const base = (process.env.ALIYUN_OSS_PUBLIC_BASE_URL || ossHost(config)).replace(/\/$/, "");
  return `${base}/${encodeObjectKey(objectKey)}`;
}

function createReadUrl({ objectKey, expiresIn = 86400 }) {
  const config = requiredConfig();
  if (!config) return null;
  if (process.env.ALIYUN_OSS_PUBLIC_READ === "true") {
    return publicUrl(config, objectKey);
  }
  return createSignedUrl({
    method: "GET",
    objectKey,
    expiresIn
  });
}

function createSignedUrl({ method, objectKey, contentType = "", expiresIn = 1800, ossHeaders = {} }) {
  const config = requiredConfig();
  if (!config) return null;
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const signature = sign({
    method,
    bucket: config.bucket,
    objectKey,
    expires,
    contentType,
    accessKeySecret: config.accessKeySecret,
    ossHeaders
  });
  const host = ossHost(config);
  return `${host}/${encodeObjectKey(objectKey)}?OSSAccessKeyId=${encodeURIComponent(config.accessKeyId)}&Expires=${expires}&Signature=${encodeURIComponent(signature)}`;
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const contentType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] || "";
  return {
    contentType,
    buffer: isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data))
  };
}

async function uploadBuffer({ buffer, fileName, contentType, folder = "uploads", tenantId = "tenant-demo" }) {
  const token = createUploadToken({ fileName, contentType, tenantId, folder });
  if (!token || !token.upload_url) return null;
  const res = await fetch(token.upload_url, {
    method: "PUT",
    headers: token.headers,
    body: buffer
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OSS server upload failed: ${res.status} ${text}`);
  }
  return token;
}

async function uploadDataUrl({ dataUrl, fileName, folder = "uploads", tenantId = "tenant-demo" }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  return uploadBuffer({
    buffer: parsed.buffer,
    fileName,
    contentType: parsed.contentType,
    folder,
    tenantId
  });
}

function createUploadToken({ fileName, contentType, tenantId = "tenant-demo", folder = "uploads" }) {
  const config = requiredConfig();
  if (!config) return null;
  const safeName = String(fileName || "asset").replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  const ext = extensionFromName(safeName, contentType);
  const objectKey = `${tenantId}/${folder}/${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
  const usePublicRead = process.env.ALIYUN_OSS_PUBLIC_READ === "true";
  const ossHeaders = usePublicRead && process.env.ALIYUN_OSS_ALLOW_OBJECT_ACL === "true"
    ? { "x-oss-object-acl": process.env.ALIYUN_OSS_OBJECT_ACL || "public-read" }
    : {};
  const uploadUrl = createSignedUrl({
    method: "PUT",
    objectKey,
    contentType: contentType || "application/octet-stream",
    expiresIn: 1800,
    ossHeaders
  });
  const readUrl = createReadUrl({
    objectKey,
    expiresIn: Number(process.env.ALIYUN_OSS_READ_EXPIRES_SECONDS || 86400)
  });
  return {
    provider: "aliyun-oss",
    bucket: config.bucket,
    object_key: objectKey,
    upload_url: uploadUrl,
    read_url: readUrl,
    expires_in: 1800,
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      ...ossHeaders
    }
  };
}

function isConfigured() {
  return Boolean(requiredConfig());
}

module.exports = {
  createUploadToken,
  createSignedUrl,
  createReadUrl,
  uploadDataUrl,
  isConfigured
};
