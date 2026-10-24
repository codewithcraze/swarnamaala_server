import nodemailer from "nodemailer";

// Gmail / Google Workspace SMTP using an App Password.
// APPPASSCODE is the 16-char app password; MAIL_USER is the sending address.
const MAIL_USER = process.env.MAIL_USER || process.env.ADMIN_EMAIL || "";
const APP_PASS = (process.env.APPPASSCODE || "").replace(/\s+/g, "");
const MAIL_FROM = process.env.MAIL_FROM || MAIL_USER;

let transporter = null;

function getTransporter() {
  if (!MAIL_USER || !APP_PASS) {
    console.warn("[mail] MAIL_USER or APPPASSCODE not set — emails are disabled.");
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: MAIL_USER, pass: APP_PASS },
    });
  }
  return transporter;
}

/**
 * Send an email. Never throws — failures are logged so they don't break the
 * request that triggered them.
 * @param {{ to: string, subject: string, html: string, text?: string }} opts
 */
export async function sendMail({ to, subject, html, text }) {
  if (!to) return { ok: false, skipped: "no-recipient" };
  const tx = getTransporter();
  if (!tx) return { ok: false, skipped: "not-configured" };
  try {
    const info = await tx.sendMail({
      from: MAIL_FROM,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    });
    console.log(`[mail] sent "${subject}" to ${to} (id: ${info.messageId})`);
    return { ok: true };
  } catch (err) {
    console.error("[mail] send failed:", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

const BRAND = "Swarnamaala";
const SHELL = (inner) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a">
    <div style="background:#b8860b;padding:18px 24px;border-radius:8px 8px 0 0">
      <h1 style="margin:0;color:#fff;font-size:20px">${BRAND}</h1>
    </div>
    <div style="border:1px solid #eee;border-top:none;padding:24px;border-radius:0 0 8px 8px">
      ${inner}
      <p style="margin-top:28px;font-size:12px;color:#888">
        This is an automated message from ${BRAND}. Please do not reply to this email.
      </p>
    </div>
  </div>`;

// Friendly label for each order status.
const STATUS_COPY = {
  pending: "received and is awaiting processing",
  processing: "being prepared",
  shipped: "on its way to you",
  delivered: "delivered",
  cancelled: "cancelled",
};

export function orderStatusEmail({ name, orderId, status }) {
  const shortId = String(orderId).slice(-8).toUpperCase();
  const phrase = STATUS_COPY[status] || `now marked as "${status}"`;
  const subject = `Your order #${shortId} is ${status}`;
  const html = SHELL(`
    <p>Hi ${name || "there"},</p>
    <p>Your order <strong>#${shortId}</strong> is <strong>${phrase}</strong>.</p>
    ${
      status === "shipped"
        ? "<p>You'll receive it soon. Thank you for your patience!</p>"
        : status === "delivered"
        ? "<p>We hope you love your custom photo magnets. Thank you for shopping with us!</p>"
        : status === "cancelled"
        ? "<p>If this wasn't expected, please reach out to our support team.</p>"
        : "<p>We'll keep you posted as it moves along.</p>"
    }
  `);
  return { subject, html };
}
