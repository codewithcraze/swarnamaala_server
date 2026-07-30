import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import { connectDB } from "./db.js";
import { User, Order, Blog } from "./models.js";
import { signAdminToken, requireAdmin } from "./auth.js";
import { uploadBuffer } from "./s3.js";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(express.json());
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
    const [userCount, orderCount, revenueAgg, referralAgg, statusAgg] = await Promise.all([
      User.countDocuments({}),
      Order.countDocuments({}),
      Order.aggregate([
        { $match: { status: { $ne: "cancelled" } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$total", "$amount"] } } } },
      ]),
      User.aggregate([{ $group: { _id: null, total: { $sum: "$walletBalance" } } }]),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);
    const statusCounts = {};
    statusAgg.forEach((s) => (statusCounts[s._id || "unknown"] = s.count));
    res.json({
      users: userCount,
      orders: orderCount,
      revenue: revenueAgg[0]?.total ?? 0,
      referralPayouts: referralAgg[0]?.total ?? 0,
      statusCounts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load stats." });
  }
});

// --- Users (with day-wise grouping) ---
app.get("/api/users", requireAdmin, async (_req, res) => {
  try {
    const users = await User.find({})
      .select("name email phone createdAt referralCode walletBalance referredBy")
      .sort({ createdAt: -1 })
      .lean();

    // Group by registration day (YYYY-MM-DD).
    const groups = {};
    for (const u of users) {
      const day = new Date(u.createdAt).toISOString().slice(0, 10);
      (groups[day] ||= []).push(u);
    }
    const daywise = Object.entries(groups)
      .map(([date, list]) => ({ date, count: list.length, users: list }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    res.json({ total: users.length, daywise });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load users." });
  }
});

// --- Orders ---
app.get("/api/orders", requireAdmin, async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = String(req.query.status);
    const orders = await Order.find(filter)
      .populate("user", "name email phone")
      .populate("referrer", "name email referralCode")
      .sort({ createdAt: -1 })
      .lean();
    res.json({ orders });
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
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

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
    if (!["unpaid", "paid", "refunded"].includes(paymentStatus)) {
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

connectDB(MONGODB_URI).then(() => {
  app.listen(PORT, () => console.log(`[crm] API listening on http://localhost:${PORT}`));
});
