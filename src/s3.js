import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const REGION = process.env.REGION || "us-east-1";
const BUCKET = process.env.BUCKETNAME || "";
const ACCESS_KEY = process.env.ACCESSKEY || "";
const SECRET_KEY = process.env.SECRETKEY || "";
// Main site base URL, used to build proxied image URLs (site serves the
// private S3 objects via /api/images/...).
const SITE_URL = process.env.SITE_URL || "http://localhost:3000";

export const s3Configured = Boolean(BUCKET && ACCESS_KEY && SECRET_KEY);

const s3 = s3Configured
  ? new S3Client({
      region: REGION,
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    })
  : null;

const EXT_BY_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const EXT_BY_CONTENT_TYPE = EXT_BY_TYPE;

export async function uploadBuffer(buffer, contentType) {
  if (!s3) throw new Error("S3 is not configured on the CRM backend.");
  const ext = EXT_BY_TYPE[contentType] || "jpg";
  const key = `uploads/${Date.now()}-${crypto.randomBytes(8).toString("hex")}.${ext}`;
  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType })
  );
  // Absolute URL served through the main site's image proxy.
  return `${SITE_URL}/api/images/${key}`;
}

// Extract the S3 object key from a stored image value. Images are stored either
// as an absolute proxy URL (".../api/images/uploads/xxx.jpg") or, in older data,
// a relative path ("/api/images/uploads/xxx.jpg"). Returns null if the value
// doesn't resolve to a safe "uploads/..." key.
export function keyFromImageUrl(url) {
  if (!url) return null;
  const marker = "/api/images/";
  const idx = url.indexOf(marker);
  let key = idx >= 0 ? url.slice(idx + marker.length) : url;
  key = key.replace(/^\/+/, "").split("?")[0];
  if (!key.startsWith("uploads/") || key.includes("..")) return null;
  return key;
}

// Fetch an object's bytes + content type directly from S3.
export async function getS3Object(key) {
  if (!s3) throw new Error("S3 is not configured on the CRM backend.");
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = Buffer.from(await res.Body.transformToByteArray());
  return { bytes, contentType: res.ContentType || "application/octet-stream" };
}

// Delete objects from S3 given a list of stored image URLs/paths. Only keys
// that resolve to a safe "uploads/..." path are deleted. Returns the number of
// objects requested for deletion. Best-effort: logs but doesn't throw so the
// caller can still delete the order even if storage cleanup partly fails.
export async function deleteImagesByUrl(imageUrls) {
  if (!s3) {
    console.warn("[s3] not configured — skipping image deletion.");
    return 0;
  }
  const keys = (Array.isArray(imageUrls) ? imageUrls : [])
    .map((u) => keyFromImageUrl(u))
    .filter(Boolean);
  if (keys.length === 0) return 0;

  // DeleteObjects handles up to 1000 keys per request; batch to be safe.
  const BATCH = 1000;
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    try {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        })
      );
    } catch (err) {
      console.error("[s3] delete batch failed:", err?.message || err);
    }
  }
  return keys.length;
}
