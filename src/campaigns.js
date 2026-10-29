// Email campaigns: broadcast emails to customers, an image library for
// campaign images, unsubscribe handling, and AI-written templates.
import multer from "multer";
import { User, Order, Campaign, Media, Suppression } from "./models.js";
import { requireAdmin, signUnsubToken, verifyUnsubToken } from "./auth.js";
import { sendMail, mailConfigured } from "./mail.js";
import { uploadBuffer, deleteImagesByUrl } from "./s3.js";

const SITE_URL = (process.env.SITE_URL || "https://www.swarnamaala.in").replace(/\/$/, "");
// Emails sent per /send-batch call, and the pause between two emails. Gmail
// allows roughly 500 (personal) or 2000 (Workspace) messages a day.
const BATCH_SIZE = Math.max(1, Number(process.env.CAMPAIGN_BATCH_SIZE) || 10);
const SEND_DELAY_MS = Math.max(0, Number(process.env.CAMPAIGN_DELAY_MS) || 400);
const BATCH_TIME_MS = Math.max(2000, Number(process.env.CAMPAIGN_BATCH_MS) || 7000);
const MAX_CUSTOM_EMAILS = 5000;
const AUDIENCES = ["all", "buyers", "nonBuyers", "custom"];
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function parseEmails(input) {
  const raw = Array.isArray(input) ? input.join("\n") : String(input || "");
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const e = part.trim().toLowerCase();
    if (e && EMAIL_RX.test(e) && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out.slice(0, MAX_CUSTOM_EMAILS);
}

// Who a campaign goes to. Unsubscribed addresses are always left out.
async function resolveAudience(audience) {
  const type = AUDIENCES.includes(audience?.type) ? audience.type : "all";
  const suppressed = new Set((await Suppression.find({}).select("email").lean()).map((s) => s.email));
  let people;
  if (type === "custom") {
    const emails = parseEmails(audience?.emails);
    const users = await User.find({ email: { $in: emails } }).select("name email").lean();
    const names = new Map(users.map((u) => [String(u.email).toLowerCase(), u.name]));
    people = emails.map((email) => ({ email, name: names.get(email) || "" }));
  } else {
    const filter = { email: { $exists: true, $nin: ["", null] } };
    if (type !== "all") {
      const buyerIds = await Order.distinct("user", { paymentStatus: "paid" });
      filter._id = type === "buyers" ? { $in: buyerIds } : { $nin: buyerIds };
    }
    people = (await User.find(filter).select("name email").lean()).map((u) => ({
      email: String(u.email).toLowerCase(),
      name: u.name || "",
    }));
  }
  const seen = new Set();
  const recipients = [];
  let suppressedCount = 0;
  for (const p of people) {
    if (seen.has(p.email)) continue;
    seen.add(p.email);
    if (suppressed.has(p.email)) suppressedCount += 1;
    else recipients.push(p);
  }
  return { recipients, suppressedCount };
}

// Base URL recipients use for the unsubscribe link. Set PUBLIC_API_URL to the
// deployed CRM API; otherwise the incoming request's host is used, which is
// localhost when sending from local dev.
function publicBase(req) {
  return (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

const UNSUB_RX = /\{\{\s*unsubscribe_url\s*\}\}/i;

// Fill {{placeholders}} for one recipient, add the hidden preheader and make
// sure every email carries an unsubscribe link.
export function renderEmail({ html, subject, preheader }, person, unsubUrl) {
  const name = (person.name || "").trim();
  const values = {
    name: name || "there",
    first_name: name.split(/\s+/)[0] || "there",
    email: person.email,
    unsubscribe_url: unsubUrl,
    site_url: SITE_URL,
  };
  const fill = (s, esc) =>
    String(s || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
      if (!(k in values)) return m;
      return esc && k !== "unsubscribe_url" && k !== "site_url" ? escapeHtml(values[k]) : values[k];
    });

  let out = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, "");
  const hadUnsub = UNSUB_RX.test(out);
  out = fill(out, true);

  if (preheader) {
    const hidden = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(fill(preheader, false))}</div>`;
    out = /<body[^>]*>/i.test(out) ? out.replace(/<body[^>]*>/i, (m) => m + hidden) : hidden + out;
  }
  if (!hadUnsub) {
    const footer = `<div style="text-align:center;font:12px Arial,sans-serif;color:#888;padding:16px">You're receiving this because you're a Swarnamaala customer. <a href="${unsubUrl}" style="color:#888">Unsubscribe</a></div>`;
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, footer + "</body>") : out + footer;
  }
  return { html: out, subject: fill(subject, false) };
}

function unsubUrlFor(req, email) {
  return `${publicBase(req)}/api/unsubscribe?t=${encodeURIComponent(signUnsubToken(email))}`;
}

function unsubHeaders(url) {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

function campaignInput(b) {
  const out = {};
  if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 150) || "Untitled campaign";
  if (b.subject !== undefined) out.subject = String(b.subject).slice(0, 250);
  if (b.preheader !== undefined) out.preheader = String(b.preheader).slice(0, 250);
  if (b.html !== undefined) out.html = String(b.html).slice(0, 500_000);
  if (b.audience !== undefined) {
    const type = AUDIENCES.includes(b.audience?.type) ? b.audience.type : "all";
    out.audience = { type, emails: type === "custom" ? parseEmails(b.audience?.emails) : [] };
  }
  return out;
}

function unsubPage(title, body, form) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:Arial,sans-serif;background:#f6f4ef;margin:0;padding:48px 16px">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.06)">
<h1 style="font-size:20px;margin:0 0 12px;color:#1a1a1a">${title}</h1><p style="color:#555;line-height:1.5">${body}</p>${form || ""}
<p style="margin-top:24px"><a href="${SITE_URL}" style="color:#b8860b">Back to Swarnamaala</a></p></div></body></html>`;
}

export function registerCampaignRoutes(app) {
  // ---------- Public unsubscribe (no admin auth) ----------
  // GET shows a confirm button so link scanners don't unsubscribe people by
  // accident; POST (also used by Gmail's one-click unsubscribe) does it.
  app.get("/api/unsubscribe", (req, res) => {
    const email = verifyUnsubToken(req.query.t);
    if (!email) return res.status(400).send(unsubPage("Link not valid", "This unsubscribe link is invalid or incomplete."));
    const action = `/api/unsubscribe?t=${encodeURIComponent(String(req.query.t))}`;
    res.send(
      unsubPage(
        "Unsubscribe from emails?",
        `We'll stop sending offers and news to <b>${escapeHtml(email)}</b>. Order updates will still arrive.`,
        `<form method="POST" action="${action}"><button style="background:#b8860b;color:#fff;border:0;border-radius:8px;padding:12px 22px;font-size:15px;cursor:pointer">Unsubscribe</button></form>`
      )
    );
  });
  app.post("/api/unsubscribe", async (req, res) => {
    const email = verifyUnsubToken(req.query.t);
    if (!email) return res.status(400).send(unsubPage("Link not valid", "This unsubscribe link is invalid or incomplete."));
    try {
      await Suppression.updateOne({ email }, { $setOnInsert: { email } }, { upsert: true });
      res.send(unsubPage("You're unsubscribed", `<b>${escapeHtml(email)}</b> won't receive marketing emails from us again.`));
    } catch (err) {
      console.error("unsubscribe error", err);
      res.status(500).send(unsubPage("Something went wrong", "Please try again in a moment."));
    }
  });

  // ---------- Media library ----------
  app.get("/api/media", requireAdmin, async (_req, res) => {
    try {
      const media = await Media.find({}).sort({ createdAt: -1 }).limit(500).lean();
      res.json({ media });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load images." });
    }
  });

  app.post("/api/media", requireAdmin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file provided." });
      const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
      if (!allowed.includes(req.file.mimetype)) {
        return res.status(415).json({ error: "Use a JPG, PNG, WebP or GIF image." });
      }
      const url = await uploadBuffer(req.file.buffer, req.file.mimetype);
      const media = await Media.create({
        url,
        name: String(req.file.originalname || "image").slice(0, 200),
        size: req.file.size,
        contentType: req.file.mimetype,
        uploadedBy: req.admin?.email,
      });
      res.json({ media });
    } catch (err) {
      console.error("media upload error", err);
      res.status(500).json({ error: err?.message?.includes("S3") ? err.message : "Upload failed." });
    }
  });

  app.delete("/api/media/:id", requireAdmin, async (req, res) => {
    try {
      const media = await Media.findById(req.params.id);
      if (!media) return res.status(404).json({ error: "Image not found." });
      await deleteImagesByUrl([media.url]);
      await media.deleteOne();
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete image." });
    }
  });

  // ---------- Campaigns ----------
  app.get("/api/campaigns/meta", requireAdmin, async (req, res) => {
    const unsubBase = publicBase(req);
    res.json({
      unsubBase,
      unsubLocal: isLocalUrl(unsubBase),
      imagesLocal: isLocalUrl(SITE_URL),
      mailConfigured: mailConfigured(),
      aiConfigured: !!process.env.AI_API_KEY,
      siteUrl: SITE_URL,
      batchSize: BATCH_SIZE,
      unsubscribed: await Suppression.countDocuments({}),
    });
  });

  app.post("/api/campaigns/audience-count", requireAdmin, async (req, res) => {
    try {
      const { recipients, suppressedCount } = await resolveAudience(req.body?.audience);
      res.json({ count: recipients.length, suppressed: suppressedCount });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to count recipients." });
    }
  });

  app.get("/api/campaigns", requireAdmin, async (_req, res) => {
    try {
      const campaigns = await Campaign.find({}).select("-html").sort({ createdAt: -1 }).limit(200).lean();
      res.json({ campaigns });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load campaigns." });
    }
  });

  app.post("/api/campaigns", requireAdmin, async (req, res) => {
    try {
      const campaign = await Campaign.create({
        name: "Untitled campaign",
        ...campaignInput(req.body || {}),
        status: "draft",
        createdBy: req.admin?.email,
      });
      res.json({ campaign });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to create campaign." });
    }
  });

  app.get("/api/campaigns/:id", requireAdmin, async (req, res) => {
    try {
      const campaign = await Campaign.findById(req.params.id).lean();
      if (!campaign) return res.status(404).json({ error: "Campaign not found." });
      res.json({ campaign });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load campaign." });
    }
  });

  app.put("/api/campaigns/:id", requireAdmin, async (req, res) => {
    try {
      const campaign = await Campaign.findById(req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campaign not found." });
      if (campaign.status !== "draft") {
        return res.status(409).json({ error: "This campaign has already been sent. Duplicate it to make changes." });
      }
      Object.assign(campaign, campaignInput(req.body || {}));
      await campaign.save();
      res.json({ campaign });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to save campaign." });
    }
  });

  app.post("/api/campaigns/:id/duplicate", requireAdmin, async (req, res) => {
    try {
      const src = await Campaign.findById(req.params.id).lean();
      if (!src) return res.status(404).json({ error: "Campaign not found." });
      const campaign = await Campaign.create({
        name: `${src.name} (copy)`.slice(0, 150),
        subject: src.subject,
        preheader: src.preheader,
        html: src.html,
        audience: src.audience,
        status: "draft",
        createdBy: req.admin?.email,
      });
      res.json({ campaign });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to duplicate campaign." });
    }
  });

  app.delete("/api/campaigns/:id", requireAdmin, async (req, res) => {
    try {
      const campaign = await Campaign.findById(req.params.id).select("status");
      if (!campaign) return res.status(404).json({ error: "Campaign not found." });
      if (campaign.status === "sending") return res.status(409).json({ error: "Pause the campaign before deleting it." });
      await campaign.deleteOne();
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete campaign." });
    }
  });

  // Send the current (unsaved) content to one address to check it.
  app.post("/api/campaigns/test", requireAdmin, async (req, res) => {
    try {
      if (!mailConfigured()) return res.status(503).json({ error: "Email isn't set up on the server (MAIL_USER / APPPASSCODE)." });
      const to = String(req.body?.to || "").trim().toLowerCase();
      if (!EMAIL_RX.test(to)) return res.status(400).json({ error: "Enter a valid email address." });
      const b = req.body || {};
      if (!String(b.subject || "").trim() || !String(b.html || "").trim()) {
        return res.status(400).json({ error: "Add a subject and some content first." });
      }
      const user = await User.findOne({ email: to }).select("name").lean();
      const unsub = unsubUrlFor(req, to);
      const { html, subject } = renderEmail(
        { html: b.html, subject: b.subject, preheader: b.preheader },
        { email: to, name: user?.name || "Test User" },
        unsub
      );
      const sent = await sendMail({ to, subject: `[TEST] ${subject}`, html, headers: unsubHeaders(unsub) });
      if (!sent.ok) return res.status(502).json({ error: sent.error || "The email could not be sent." });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to send test email." });
    }
  });

  // Freeze the recipient list and mark the campaign as sending. The CRM then
  // calls /send-batch repeatedly, which works on serverless hosts too.
  app.post("/api/campaigns/:id/start", requireAdmin, async (req, res) => {
    try {
      if (!mailConfigured()) return res.status(503).json({ error: "Email isn't set up on the server (MAIL_USER / APPPASSCODE)." });
      const campaign = await Campaign.findById(req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campaign not found." });
      if (campaign.status !== "draft") return res.status(409).json({ error: "This campaign has already been started." });
      if (!campaign.subject.trim()) return res.status(400).json({ error: "Add a subject line before sending." });
      if (!campaign.html.trim()) return res.status(400).json({ error: "The email has no content." });

      const { recipients } = await resolveAudience(campaign.audience);
      if (recipients.length === 0) return res.status(400).json({ error: "No one to send to in this audience." });

      campaign.recipients = recipients.map((r) => ({ ...r, status: "pending" }));
      campaign.stats = { total: recipients.length, sent: 0, failed: 0, skipped: 0 };
      campaign.status = "sending";
      campaign.startedAt = new Date();
      await campaign.save();
      res.json({ ok: true, stats: campaign.stats, status: campaign.status });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to start campaign." });
    }
  });

  app.post("/api/campaigns/:id/send-batch", requireAdmin, async (req, res) => {
    const now = new Date();
    let locked = null;
    try {
      locked = await Campaign.findOneAndUpdate(
        { _id: req.params.id, status: "sending", $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + 90_000) } },
        { new: true }
      ).select("+recipients");

      if (!locked) {
        const c = await Campaign.findById(req.params.id).select("status stats").lean();
        if (!c) return res.status(404).json({ error: "Campaign not found." });
        // Another tab is sending this batch, or the campaign isn't sending.
        return res.json({ busy: c.status === "sending", status: c.status, stats: c.stats, done: c.status === "sent" });
      }

      const suppressed = new Set((await Suppression.find({}).select("email").lean()).map((s) => s.email));
      const pending = [];
      locked.recipients.forEach((r, i) => {
        if (r.status === "pending" && pending.length < BATCH_SIZE) pending.push(i);
      });

      // Stop early if this request is running long, so hosts with short
      // request limits (e.g. Vercel's 10 s) don't kill it mid-batch. Unsent
      // recipients stay "pending" for the next call.
      const deadline = Date.now() + BATCH_TIME_MS;
      let sentNow = 0;
      for (const i of pending) {
        if (Date.now() > deadline) break;
        const r = locked.recipients[i];
        if (suppressed.has(r.email)) {
          r.status = "skipped";
          continue;
        }
        const unsub = unsubUrlFor(req, r.email);
        const { html, subject } = renderEmail(locked, r, unsub);
        const result = await sendMail({ to: r.email, subject, html, headers: unsubHeaders(unsub), quiet: true });
        if (result.ok) {
          r.status = "sent";
          r.sentAt = new Date();
          sentNow += 1;
        } else {
          r.status = "failed";
          r.error = String(result.error || result.skipped || "failed").slice(0, 300);
        }
        if (SEND_DELAY_MS) await sleep(SEND_DELAY_MS);
      }

      const count = (s) => locked.recipients.filter((r) => r.status === s).length;
      locked.stats = {
        total: locked.recipients.length,
        sent: count("sent"),
        failed: count("failed"),
        skipped: count("skipped"),
      };
      const remaining = count("pending");
      if (remaining === 0) {
        locked.status = "sent";
        locked.finishedAt = new Date();
      }
      locked.lockedUntil = null;
      locked.markModified("recipients");
      await locked.save();
      console.log(`[campaign] ${locked._id} batch: +${sentNow} sent, ${remaining} left`);
      res.json({ status: locked.status, stats: locked.stats, remaining, done: remaining === 0 });
    } catch (err) {
      console.error(err);
      if (locked) await Campaign.updateOne({ _id: locked._id }, { $set: { lockedUntil: null } }).catch(() => {});
      res.status(500).json({ error: "Sending failed for this batch." });
    }
  });

  app.post("/api/campaigns/:id/pause", requireAdmin, async (req, res) => {
    const c = await Campaign.findOneAndUpdate(
      { _id: req.params.id, status: "sending" },
      { $set: { status: "paused" } },
      { new: true }
    ).lean();
    if (!c) return res.status(409).json({ error: "This campaign isn't sending." });
    res.json({ status: c.status, stats: c.stats });
  });

  app.post("/api/campaigns/:id/resume", requireAdmin, async (req, res) => {
    const c = await Campaign.findOneAndUpdate(
      { _id: req.params.id, status: "paused" },
      { $set: { status: "sending", lockedUntil: null } },
      { new: true }
    ).lean();
    if (!c) return res.status(409).json({ error: "This campaign isn't paused." });
    res.json({ status: c.status, stats: c.stats });
  });

  app.get("/api/campaigns/:id/failures", requireAdmin, async (req, res) => {
    const c = await Campaign.findById(req.params.id).select("+recipients").lean();
    if (!c) return res.status(404).json({ error: "Campaign not found." });
    res.json({ failures: (c.recipients || []).filter((r) => r.status === "failed").slice(0, 500) });
  });

  // ---------- AI-written templates ----------
  // Works with any OpenAI-compatible chat API (OpenAI, Gemini's OpenAI
  // endpoint, Groq, OpenRouter...). Configure AI_API_KEY, AI_BASE_URL, AI_MODEL.
  app.post("/api/ai/email-template", requireAdmin, async (req, res) => {
    const key = process.env.AI_API_KEY;
    if (!key) {
      return res.status(503).json({ error: "AI isn't set up. Add AI_API_KEY (and optionally AI_BASE_URL, AI_MODEL) to the server .env." });
    }
    const b = req.body || {};
    const prompt = String(b.prompt || "").trim().slice(0, 3000);
    if (!prompt) return res.status(400).json({ error: "Describe the email you want." });
    const images = (Array.isArray(b.images) ? b.images : []).map(String).filter((u) => /^https?:\/\//.test(u)).slice(0, 8);
    const current = String(b.currentHtml || "").slice(0, 60_000);
    const mode = b.mode === "edit" && current ? "edit" : "new";

    const system = `You write marketing emails for Swarnamaala (${SITE_URL}), an Indian shop selling custom photo fridge magnets (packs of 6 for Rs 299, 12 for Rs 499, 18 for Rs 699; customers upload their own photos).
Return ONLY a JSON object: {"subject": string, "preheader": string, "html": string}.
HTML rules: a complete email-safe HTML document; table-based layout, max width 600px, centred; ALL styles inline (no <style> classes relied on, no scripts, no external CSS, no web fonts); dark gold brand accent #b8860b on warm light background #f6f4ef; mobile friendly; bulletproof button links pointing to ${SITE_URL}/products/custom-magnets unless told otherwise; images with width attribute, style="display:block;max-width:100%;height:auto" and meaningful alt text.
Use the placeholder {{first_name}} for the greeting and include a footer containing a link with href="{{unsubscribe_url}}" labelled Unsubscribe. Keep the copy short, warm and honest: do not invent discounts, prices, deadlines or reviews unless the request gives them. Write in English unless asked otherwise.`;

    const userMsg =
      (mode === "edit"
        ? `Revise this existing email according to the request, keeping its structure unless asked.\nRequest: ${prompt}\n\nCurrent HTML:\n${current}`
        : `Request: ${prompt}`) +
      (b.tone ? `\nTone: ${String(b.tone).slice(0, 60)}` : "") +
      (images.length ? `\nUse these image URLs exactly (in this order where it makes sense):\n${images.join("\n")}` : "\nDo not include any <img> tags unless an image URL is given.");

    try {
      const base = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
      const r = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.AI_MODEL || "gpt-4o-mini",
          temperature: 0.7,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: userMsg },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        console.error("AI error", r.status, data?.error?.message || data);
        return res.status(502).json({ error: `AI provider error: ${data?.error?.message || r.status}` });
      }
      let text = data?.choices?.[0]?.message?.content || "";
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      let out;
      try {
        out = JSON.parse(text);
      } catch {
        return res.status(502).json({ error: "The AI reply wasn't in the expected format. Try again." });
      }
      if (typeof out?.html !== "string" || !out.html.trim()) {
        return res.status(502).json({ error: "The AI didn't return any email content. Try again." });
      }
      res.json({
        subject: String(out.subject || "").slice(0, 250),
        preheader: String(out.preheader || "").slice(0, 250),
        html: out.html.replace(/<script[\s\S]*?<\/script>/gi, ""),
      });
    } catch (err) {
      console.error("AI request failed", err?.message || err);
      const timeout = err?.name === "TimeoutError";
      res.status(504).json({ error: timeout ? "The AI took too long. Try a shorter request." : "Couldn't reach the AI provider." });
    }
  });
}
