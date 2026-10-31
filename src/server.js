import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { connectDB } from "./db.js";
import { User, Order, Blog, Coupon } from "./models.js";
import { signAdminToken, requireAdmin } from "./auth.js";
import { uploadBuffer, getS3Object, keyFromImageUrl, EXT_BY_CONTENT_TYPE, deleteImagesByUrl } from "./s3.js";
import crypto from "node:crypto";
import { sendMail, orderStatusEmail, passwordResetEmail, mailConfigured } from "./mail.js";
import multer from "multer";
// archiver v8 is pure ESM and exports format classes (no callable default).
import { ZipArchive } from "archiver";
import { registerCampaignRoutes } from "./campaigns.js";
import { registerAgentRoutes } from "./agents.js";
import mongoose from "mongoose";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
// Behind a proxy (Vercel/Render/nginx) so req.protocol/host are the public ones.
app.set("trust proxy", 1);
// Campaign HTML can be a few hundred KB.
app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin: process.env.CRM_FRONTEND_ORIGIN?.split(",") ?? "*",
  })
);

const PORT = process.env.PORT || 5001;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@swarnamaala.in").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin12345";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in environment.");
  process.exit(1);
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// --- Admin login ---
// Accepts either the env super-admin credentials OR any DB user with role "admin".
app.post("/api/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  // 1. Env super-admin.
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    return res.json({ token: signAdminToken(email), admin: { email, name: "Super Admin" } });
  }

  // 2. Admin-role user from the database.
  try {
    const user = await User.findOne({ email });
    if (user && user.role === "admin" && user.passwordHash) {
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (ok) {
        return res.json({
          token: signAdminToken(email),
          admin: { email, name: user.name },
        });
      }
    }
  } catch (err) {
    console.error("login error", err);
  }

  return res.status(401).json({ error: "Invalid admin credentials." });
});

// --- Dashboard stats ---
app.get("/api/stats", requireAdmin, async (_req, res) => {
  try {
    const [userCount, orderCount, revenueAgg, referralAgg, statusAgg, paymentStatusAgg, sourceAgg] = await Promise.all([
      User.countDocuments({}),
      Order.countDocuments({}),
      Order.aggregate([
        { $match: { status: { $ne: "cancelled" } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$total", "$amount"] } } } },
      ]),
      User.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: "$paymentStatus", count: { $sum: 1 } } }]),
      // Older orders have no source: they came from the main site.
      Order.aggregate([{ $group: { _id: { $ifNull: ["$source", "website"] }, count: { $sum: 1 } } }]),
    ]);
    const sourceCounts = {};
    sourceAgg.forEach((s) => (sourceCounts[s._id || "website"] = s.count));
    const statusCounts = {};
    statusAgg.forEach((s) => (statusCounts[s._id || "unknown"] = s.count));
    const paymentStatusCounts = {};
    paymentStatusAgg.forEach((p) => (paymentStatusCounts[p._id || "unpaid"] = p.count));
    res.json({
      users: userCount,
      orders: orderCount,
      revenue: revenueAgg[0]?.total ?? 0,
      referralPayouts: referralAgg[0]?.total ?? 0,
      statusCounts,
      paymentStatusCounts,
      sourceCounts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load stats." });
  }
});

// Clamp pagination params to safe bounds. Returns { page, limit, skip }.
function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  let page = parseInt(query.page, 10);
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  return { page, limit, skip: (page - 1) * limit };
}

// --- Users (paginated, with optional text search) ---
app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const filter = {};
    const search = String(req.query.search || "").trim();
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { referralCode: rx }];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("name email phone role createdAt referralCode walletBalance referredBy")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({ users, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load users." });
  }
});

// --- Orders (paginated, filterable) ---
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const filter = {};
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.paymentStatus) filter.paymentStatus = String(req.query.paymentStatus);
    // Order source: "website" (incl. older orders without a source) or a platform id.
    if (req.query.source) {
      const source = String(req.query.source);
      if (source === "website") filter.source = { $in: ["website", null] };
      else if (source === "marketplace") filter.source = { $nin: ["website", null] };
      else filter.source = source;
    }
    // Agent who took the order: an agent id, or "none" for unassigned.
    if (req.query.agent) {
      const a = String(req.query.agent);
      if (a === "none") filter.agent = null;
      else if (mongoose.isValidObjectId(a)) filter.agent = a;
      else return res.status(400).json({ error: "Invalid agent filter." });
    }
    // Search by the platform's order id.
    if (req.query.externalOrderId) {
      const q = String(req.query.externalOrderId).trim().toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (q) filter.externalOrderId = { $regex: q };
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("user", "name email phone")
        .populate("referrer", "name email referralCode")
        .populate("agent", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.json({ orders, total, page, limit, pages: Math.ceil(total / limit) || 1 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load orders." });
  }
});

const VALID_STATUS = ["pending", "processing", "shipped", "delivered", "cancelled"];

// Update order status. Crediting/reversal of referral rewards happens here.
app.patch("/api/orders/:id/status", requireAdmin, async (req, res) => {
  try {
    const status = String(req.body.status || "");
    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ error: "Invalid status." });
    }
    const order = await Order.findById(req.params.id).populate("user", "name email");
    if (!order) return res.status(404).json({ error: "Order not found." });

    const previousStatus = order.status;
    const wasDelivered = order.status === "delivered";
    order.status = status;

    // Credit the referrer once, when the order becomes delivered.
    if (
      status === "delivered" &&
      !order.referralCredited &&
      order.referrer &&
      order.referralReward > 0
    ) {
      await User.findByIdAndUpdate(order.referrer, {
        $inc: { walletBalance: order.referralReward },
      });
      order.referralCredited = true;
    }

    // Reverse a previously-credited reward if the order is cancelled.
    if (status === "cancelled" && order.referralCredited && order.referrer) {
      await User.findByIdAndUpdate(order.referrer, {
        $inc: { walletBalance: -order.referralReward },
      });
      order.referralCredited = false;
    }

    // Reverse if moved out of delivered back to a non-final state.
    if (wasDelivered && status !== "delivered" && order.referralCredited && order.referrer) {
      await User.findByIdAndUpdate(order.referrer, {
        $inc: { walletBalance: -order.referralReward },
      });
      order.referralCredited = false;
    }

    await order.save();

    // Notify the customer when the status actually changes. Awaited so we can
    // log the outcome; sendMail never throws.
    if (status !== previousStatus && order.user?.email) {
      const { subject, html } = orderStatusEmail({
        name: order.user.name,
        orderId: order._id,
        status,
      });
      await sendMail({ to: order.user.email, subject, html });
    }

    res.json({ ok: true, status: order.status, referralCredited: order.referralCredited });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update order." });
  }
});

// Update payment status.
app.patch("/api/orders/:id/payment", requireAdmin, async (req, res) => {
  try {
    const paymentStatus = String(req.body.paymentStatus || "");
    if (!["unpaid", "paid", "failed", "refunded"].includes(paymentStatus)) {
      return res.status(400).json({ error: "Invalid payment status." });
    }
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { paymentStatus },
      { new: true }
    );
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json({ ok: true, paymentStatus: order.paymentStatus });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update payment." });
  }
});

// Get a single order (full detail for the order view page).
app.get("/api/orders/:id", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("user", "name email phone")
      .populate("referrer", "name email referralCode")
        .populate("agent", "name")
      .lean();
    if (!order) return res.status(404).json({ error: "Order not found." });
    order.adminNotes = notesView(order);
    res.json({ order });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load order." });
  }
});

// --- Internal admin notes (a list; newest shown first in the CRM) ---

// Older orders stored one note in `adminNote`. Move it into the list the first
// time the notes are changed so nothing is lost.
function migrateLegacyNote(order) {
  if (order.adminNote && (!order.adminNotes || order.adminNotes.length === 0)) {
    order.adminNotes = [{ text: order.adminNote, author: "", createdAt: order.updatedAt || order.createdAt }];
  }
  order.adminNote = undefined;
}

// Notes as the CRM should see them, including an unmigrated legacy note.
function notesView(order) {
  const notes = Array.isArray(order.adminNotes) ? order.adminNotes : [];
  if (notes.length === 0 && order.adminNote) {
    return [{ _id: "legacy", text: order.adminNote, author: "", createdAt: order.updatedAt || order.createdAt }];
  }
  return notes;
}

app.post("/api/orders/:id/notes", requireAdmin, async (req, res) => {
  try {
    const text = String(req.body.text ?? "").trim().slice(0, 5000);
    if (!text) return res.status(400).json({ error: "Write a note first." });
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    migrateLegacyNote(order);
    order.adminNotes.push({ text, author: req.admin?.email || "", createdAt: new Date() });
    await order.save();
    res.json({ ok: true, adminNotes: order.adminNotes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save note." });
  }
});

app.delete("/api/orders/:id/notes/:noteId", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (req.params.noteId === "legacy") {
      order.adminNote = undefined;
    } else {
      migrateLegacyNote(order);
      const before = order.adminNotes.length;
      order.adminNotes = order.adminNotes.filter((n) => String(n._id) !== req.params.noteId);
      if (order.adminNotes.length === before) return res.status(404).json({ error: "Note not found." });
    }
    await order.save();
    res.json({ ok: true, adminNotes: notesView(order) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete note." });
  }
});

// --- Edit order details ---
const clip = (v, max) => String(v ?? "").trim().slice(0, max);
const PHONE_RX = /^\+?[0-9][0-9\s-]{6,16}$/;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ADDRESS_FIELDS = ["fullName", "phone", "line1", "line2", "city", "state", "pincode"];

app.patch("/api/orders/:id", requireAdmin, async (req, res) => {
  const bad = (error) => res.status(400).json({ error });
  try {
    const b = req.body || {};
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    if (b.product !== undefined) {
      const v = clip(b.product, 120);
      if (!v) return bad("Product name is required.");
      order.product = v;
    }
    if (b.unitLabel !== undefined) order.unitLabel = clip(b.unitLabel, 120);
    if (b.quantity !== undefined) {
      const q = Number(b.quantity);
      if (!Number.isInteger(q) || q < 1 || q > 1000) return bad("Quantity must be a whole number from 1 to 1000.");
      order.quantity = q;
    }
    if (b.note !== undefined) order.note = clip(b.note, 2000);

    for (const k of ["subtotal", "gst", "discount", "total"]) {
      if (b[k] === undefined || b[k] === "") continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0) return bad(`${k} must be zero or more.`);
      order[k] = Math.round(n * 100) / 100;
    }
    if (b.total !== undefined && b.total !== "") order.amount = order.total;
    if (b.couponCode !== undefined) order.couponCode = clip(b.couponCode, 40).toUpperCase() || null;

    if (b.source !== undefined) {
      const s = clip(b.source, 30).toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(s)) return bad("Invalid order source.");
      order.source = s;
    }
    if (b.externalOrderId !== undefined) {
      order.externalOrderId = clip(b.externalOrderId, 80).toUpperCase() || undefined;
    }
    const isWebsite = !order.source || order.source === "website";
    if (!isWebsite && !order.externalOrderId) return bad("Marketplace orders need the platform order ID.");
    if (isWebsite) order.externalOrderId = undefined;

    if (b.shippingAddress !== undefined) {
      const a = b.shippingAddress || {};
      const next = {};
      for (const f of ADDRESS_FIELDS) next[f] = clip(a[f], 200);
      const any = ADDRESS_FIELDS.some((f) => next[f]);
      if (any) {
        if (next.pincode && !/^\d{6}$/.test(next.pincode)) return bad("Pincode must be 6 digits.");
        if (next.phone && !PHONE_RX.test(next.phone)) return bad("Enter a valid shipping phone number.");
      }
      order.shippingAddress = any ? next : undefined;
    }
    // The main site requires a full address on website orders.
    if (isWebsite) {
      const a = order.shippingAddress || {};
      const missing = ["fullName", "phone", "line1", "city", "state", "pincode"].filter((f) => !a[f]);
      if (missing.length) return bad("Website orders need a full shipping address (name, phone, address, city, state, pincode).");
    }

    await order.save();
    const fresh = await Order.findById(order._id)
      .populate("user", "name email phone")
      .populate("referrer", "name email referralCode")
        .populate("agent", "name")
      .lean();
    fresh.adminNotes = notesView(fresh);
    res.json({ ok: true, order: fresh });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Another order already uses this platform order ID." });
    }
    console.error(err);
    res.status(500).json({ error: "Failed to update order." });
  }
});

// --- Edit a customer's contact details ---
app.patch("/api/users/:id", requireAdmin, async (req, res) => {
  const bad = (error) => res.status(400).json({ error });
  try {
    const b = req.body || {};
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Customer not found." });

    if (b.name !== undefined) {
      const v = clip(b.name, 120);
      if (!v) return bad("Name is required.");
      user.name = v;
    }
    if (b.email !== undefined) {
      const email = clip(b.email, 200).toLowerCase();
      if (!EMAIL_RX.test(email)) return bad("Enter a valid email address.");
      if (email !== user.email) {
        const taken = await User.exists({ email, _id: { $ne: user._id } });
        if (taken) return res.status(409).json({ error: "Another account already uses this email." });
        user.email = email;
      }
    }
    if (b.phone !== undefined) {
      const phone = clip(b.phone, 20);
      if (phone && !PHONE_RX.test(phone)) return bad("Enter a valid phone number.");
      user.phone = phone || undefined;
    }

    await user.save();
    res.json({ ok: true, user: { _id: user._id, name: user.name, email: user.email, phone: user.phone } });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "Another account already uses this email." });
    console.error(err);
    res.status(500).json({ error: "Failed to update customer." });
  }
});

// What deleting a user would remove, so the CRM can warn before confirming.
app.get("/api/users/:id/summary", requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("name email role").lean();
    if (!user) return res.status(404).json({ error: "Customer not found." });
    const [orders, referredCount] = await Promise.all([
      Order.find({ user: user._id }).select("images").lean(),
      User.countDocuments({ referredBy: user._id }),
    ]);
    const photoCount = orders.reduce((n, o) => n + (o.images?.length || 0), 0);
    res.json({ user, orderCount: orders.length, photoCount, referredCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load customer." });
  }
});

// Delete a user. Their orders (and the orders' photos in S3) are only removed
// when ?withOrders=1 is passed; otherwise a user with orders can't be deleted,
// because orders on the main site must belong to a user.
app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Customer not found." });
    if (user.role === "admin") {
      return res.status(403).json({ error: "Admin accounts can't be deleted from the CRM." });
    }

    const orders = await Order.find({ user: user._id });
    const withOrders = req.query.withOrders === "1";
    if (orders.length > 0 && !withOrders) {
      return res.status(409).json({
        error: `This customer has ${orders.length} order${orders.length === 1 ? "" : "s"}. Tick "also delete their orders" to remove them too.`,
      });
    }

    let deletedImages = 0;
    for (const order of orders) {
      // Take back a referral reward someone else earned from this order.
      if (order.referralCredited && order.referrer && order.referralReward > 0) {
        await User.findByIdAndUpdate(order.referrer, { $inc: { walletBalance: -order.referralReward } });
      }
      try {
        deletedImages += await deleteImagesByUrl(order.images);
      } catch (e) {
        console.error("user delete: image cleanup failed", e?.message || e);
      }
    }
    if (orders.length) await Order.deleteMany({ _id: { $in: orders.map((o) => o._id) } });

    // Detach references to this user elsewhere.
    await Promise.all([
      User.updateMany({ referredBy: user._id }, { $set: { referredBy: null } }),
      Order.updateMany({ referrer: user._id }, { $set: { referrer: null } }),
    ]);

    await User.deleteOne({ _id: user._id });
    console.log(`[crm] user ${user.email} deleted by ${req.admin?.email} (${orders.length} orders, ${deletedImages} photos)`);
    res.json({ ok: true, deletedOrders: orders.length, deletedImages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete customer." });
  }
});

// Readable random password without look-alike characters.
function generatePassword(len = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

// Reset a customer's password and email them the new one. The password is
// never returned to the admin. If the email can't be sent, the old password is
// restored so the customer isn't locked out.
app.post("/api/users/:id/reset-password", requireAdmin, async (req, res) => {
  try {
    if (!mailConfigured()) {
      return res.status(503).json({
        error: "Email isn't set up on the server (MAIL_USER / APPPASSCODE), so the new password can't be sent.",
      });
    }
    const user = await User.findById(req.params.id).select("name email passwordHash").lean();
    if (!user) return res.status(404).json({ error: "Customer not found." });
    if (!user.email) return res.status(400).json({ error: "This customer has no email address." });

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 12);
    await User.updateOne({ _id: user._id }, { $set: { passwordHash } });

    const { subject, html } = passwordResetEmail({
      name: user.name,
      email: user.email,
      password,
      siteUrl: process.env.SITE_URL,
    });
    const sent = await sendMail({ to: user.email, subject, html });
    if (!sent.ok) {
      await User.updateOne({ _id: user._id }, { $set: { passwordHash: user.passwordHash } });
      return res.status(502).json({ error: "Couldn't send the email, so the password was not changed." });
    }
    console.log(`[crm] password reset for ${user.email} by ${req.admin?.email}`);
    res.json({ ok: true, email: user.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to reset password." });
  }
});

// Delete an order and its uploaded photos from S3.
// Reverses any referral reward that was already credited so wallet balances
// stay consistent.
app.delete("/api/orders/:id", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    // Reverse a previously-credited referral reward before removing the order.
    if (order.referralCredited && order.referrer && order.referralReward > 0) {
      await User.findByIdAndUpdate(order.referrer, {
        $inc: { walletBalance: -order.referralReward },
      });
    }

    // Best-effort removal of the order's photos from S3.
    let deletedImages = 0;
    try {
      deletedImages = await deleteImagesByUrl(order.images);
    } catch (e) {
      console.error("order delete: image cleanup failed", e?.message || e);
    }

    await Order.deleteOne({ _id: order._id });

    res.json({ ok: true, deletedImages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete order." });
  }
});

// Download all photos for an order as a single ZIP, streamed from S3.
app.get("/api/orders/:id/images.zip", requireAdmin, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: "Order not found." });

    const images = Array.isArray(order.images) ? order.images : [];
    if (images.length === 0) {
      return res.status(404).json({ error: "This order has no photos." });
    }

    const shortId = String(order._id).slice(-8);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="order-${shortId}-photos.zip"`
    );

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("error", (err) => {
      console.error("zip error", err);
      // Headers may already be sent; just tear down the stream.
      try {
        res.destroy(err);
      } catch {
        /* noop */
      }
    });
    archive.pipe(res);

    let added = 0;
    for (let i = 0; i < images.length; i++) {
      const key = keyFromImageUrl(images[i]);
      if (!key) continue;
      try {
        const obj = await getS3Object(key);
        const ext = EXT_BY_CONTENT_TYPE[obj.contentType] || "jpg";
        archive.append(obj.bytes, { name: `photo-${i + 1}.${ext}` });
        added += 1;
      } catch (e) {
        console.error("zip: failed to fetch", key, e.message);
      }
    }

    if (added === 0) {
      // Nothing could be fetched; abort with a clear error before finalizing.
      archive.abort();
      if (!res.headersSent) {
        return res.status(502).json({ error: "Could not fetch any photos from storage." });
      }
      return res.end();
    }

    await archive.finalize();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to build ZIP." });
  }
});

// --- Referral overview: top referrers and their earnings ---
app.get("/api/referrals", requireAdmin, async (_req, res) => {
  try {
    const earners = await User.find({ walletBalance: { $gt: 0 } })
      .select("name email referralCode walletBalance")
      .sort({ walletBalance: -1 })
      .lean();

    const referredCounts = await User.aggregate([
      { $match: { referredBy: { $ne: null } } },
      { $group: { _id: "$referredBy", count: { $sum: 1 } } },
    ]);
    const countMap = {};
    referredCounts.forEach((r) => (countMap[String(r._id)] = r.count));

    const referralOrders = await Order.find({ referrer: { $ne: null } })
      .populate("referrer", "name email")
      .populate("user", "name")
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      earners: earners.map((e) => ({
        ...e,
        referredCount: countMap[String(e._id)] ?? 0,
      })),
      referralOrders,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load referrals." });
  }
});

// --- Coupons ---
const COUPON_TYPES = ["percent", "flat"];

function randomCouponCode(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

app.get("/api/coupons", requireAdmin, async (_req, res) => {
  try {
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    res.json({ coupons });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load coupons." });
  }
});

app.post("/api/coupons", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const type = String(b.type || "");
    if (!COUPON_TYPES.includes(type)) {
      return res.status(400).json({ error: "Type must be 'percent' or 'flat'." });
    }
    const value = Number(b.value);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: "Enter a valid discount value." });
    }
    if (type === "percent" && value > 100) {
      return res.status(400).json({ error: "Percentage cannot exceed 100." });
    }

    // Use provided code or auto-generate a unique one.
    let code = String(b.code || "").trim().toUpperCase().replace(/\s+/g, "");
    if (code) {
      const existing = await Coupon.findOne({ code });
      if (existing) return res.status(409).json({ error: "That coupon code already exists." });
    } else {
      // Generate until unique.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        code = randomCouponCode();
        if (!(await Coupon.findOne({ code }))) break;
      }
    }

    const coupon = await Coupon.create({
      code,
      type,
      value,
      maxDiscount: Number(b.maxDiscount) > 0 ? Number(b.maxDiscount) : 0,
      minOrderValue: Number(b.minOrderValue) > 0 ? Number(b.minOrderValue) : 0,
      usageLimit: Number(b.usageLimit) > 0 ? Number(b.usageLimit) : 0,
      active: b.active !== false,
      expiresAt: b.expiresAt ? new Date(b.expiresAt) : null,
    });
    res.json({ coupon });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create coupon." });
  }
});

app.patch("/api/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const update = {};
    const b = req.body || {};
    if (b.active !== undefined) update.active = !!b.active;
    if (b.expiresAt !== undefined) update.expiresAt = b.expiresAt ? new Date(b.expiresAt) : null;
    if (b.usageLimit !== undefined) update.usageLimit = Number(b.usageLimit) > 0 ? Number(b.usageLimit) : 0;
    if (b.minOrderValue !== undefined) update.minOrderValue = Number(b.minOrderValue) > 0 ? Number(b.minOrderValue) : 0;
    if (b.maxDiscount !== undefined) update.maxDiscount = Number(b.maxDiscount) > 0 ? Number(b.maxDiscount) : 0;

    const coupon = await Coupon.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!coupon) return res.status(404).json({ error: "Coupon not found." });
    res.json({ coupon });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update coupon." });
  }
});

app.delete("/api/coupons/:id", requireAdmin, async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndDelete(req.params.id);
    if (!coupon) return res.status(404).json({ error: "Coupon not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete coupon." });
  }
});

// --- Image upload (for blog cover + rich text images) ---
app.post("/api/upload", requireAdmin, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided." });
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(req.file.mimetype)) {
      return res.status(415).json({ error: "Unsupported image type." });
    }
    const url = await uploadBuffer(req.file.buffer, req.file.mimetype);
    res.json({ url });
  } catch (err) {
    console.error("upload error", err);
    res.status(500).json({ error: "Upload failed." });
  }
});

// --- Blog CRUD ---
function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

async function uniqueSlug(base, excludeId) {
  let slug = slugify(base) || `post-${Date.now()}`;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await Blog.findOne({ slug });
    if (!existing || String(existing._id) === String(excludeId)) return slug;
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
}

app.get("/api/blogs", requireAdmin, async (_req, res) => {
  try {
    const blogs = await Blog.find({}).sort({ createdAt: -1 }).lean();
    res.json({ blogs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load blogs." });
  }
});

app.get("/api/blogs/:id", requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id).lean();
    if (!blog) return res.status(404).json({ error: "Blog not found." });
    res.json({ blog });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load blog." });
  }
});

app.post("/api/blogs", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.title || "").trim()) {
      return res.status(400).json({ error: "Title is required." });
    }
    const slug = await uniqueSlug(b.slug || b.title);
    const blog = await Blog.create({
      title: String(b.title).trim(),
      slug,
      description: b.description || "",
      content: b.content || "",
      coverImage: b.coverImage || "",
      metaTitle: b.metaTitle || "",
      metaDescription: b.metaDescription || "",
      metaKeywords: b.metaKeywords || "",
      author: b.author || "swarnamaala.in",
      published: b.published !== false,
    });
    res.json({ blog });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create blog." });
  }
});

app.put("/api/blogs/:id", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ error: "Blog not found." });

    if (b.title !== undefined) blog.title = String(b.title).trim();
    if (b.slug !== undefined && b.slug) blog.slug = await uniqueSlug(b.slug, blog._id);
    if (b.description !== undefined) blog.description = b.description;
    if (b.content !== undefined) blog.content = b.content;
    if (b.coverImage !== undefined) blog.coverImage = b.coverImage;
    if (b.metaTitle !== undefined) blog.metaTitle = b.metaTitle;
    if (b.metaDescription !== undefined) blog.metaDescription = b.metaDescription;
    if (b.metaKeywords !== undefined) blog.metaKeywords = b.metaKeywords;
    if (b.author !== undefined) blog.author = b.author;
    if (b.published !== undefined) blog.published = !!b.published;

    await blog.save();
    res.json({ blog });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update blog." });
  }
});

app.delete("/api/blogs/:id", requireAdmin, async (req, res) => {
  try {
    const blog = await Blog.findByIdAndDelete(req.params.id);
    if (!blog) return res.status(404).json({ error: "Blog not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete blog." });
  }
});

registerCampaignRoutes(app);
registerAgentRoutes(app);

connectDB(MONGODB_URI).then(() => {
  app.listen(PORT, () => console.log(`[crm] API listening on http://localhost:${PORT}`));
});
