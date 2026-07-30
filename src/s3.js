import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

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
