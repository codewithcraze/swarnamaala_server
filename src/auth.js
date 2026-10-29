import jwt from "jsonwebtoken";

const SECRET = process.env.CRM_JWT_SECRET || "dev-crm-secret";

// Token embedded in campaign unsubscribe links. No expiry: old emails must
// keep working. Carries only the email address.
export function signUnsubToken(email) {
  return jwt.sign({ p: "unsub", e: String(email).toLowerCase() }, SECRET);
}

export function verifyUnsubToken(token) {
  try {
    const payload = jwt.verify(String(token || ""), SECRET);
    return payload.p === "unsub" && payload.e ? payload.e : null;
  } catch {
    return null;
  }
}

export function signAdminToken(email) {
  return jwt.sign({ role: "admin", email }, SECRET, { expiresIn: "12h" });
}

// Express middleware that requires a valid admin bearer token.
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.role !== "admin") throw new Error("not admin");
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}
