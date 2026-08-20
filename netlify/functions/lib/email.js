/* Shared email helper (Resend) + brand HTML shell for Mad Vervet Hostel.
   Never throws on missing config — logs a warning so bookings still succeed. */
const { Resend } = require("resend");

// From-address is env-configurable: use onboarding@resend.dev in dev until the
// madvervet.com domain is verified in Resend (test mode delivers only to the
// Resend account owner's email).
const FROM = process.env.EMAIL_FROM || "Mad Vervet Hostel <bookings@madvervet.com>";
const BRAND = { ink: "#151515", cream: "#FBF6EE", terra: "#C1502E" };

function hostelEmail() {
  return process.env.HOSTEL_NOTIFICATION_EMAIL || "info@madvervet.com";
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping email:", subject);
    return { skipped: true };
  }
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) console.error("Resend error for '" + subject + "':", error);
    return { skipped: false, error: error || null };
  } catch (err) {
    console.error("Email send failed for '" + subject + "':", err);
    return { skipped: false, error: err };
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shell(title, bodyHtml) {
  return (
    '<div style="margin:0;padding:24px;background:' + BRAND.cream +
    ';font-family:Arial,Helvetica,sans-serif;color:' + BRAND.ink + '">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:3px solid ' + BRAND.ink + '">' +
    '<div style="background:' + BRAND.terra + ';color:' + BRAND.cream +
    ';padding:16px 24px;font-size:20px;font-weight:bold">' + esc(title) + "</div>" +
    '<div style="padding:24px;font-size:15px;line-height:1.5">' + bodyHtml + "</div>" +
    '<div style="padding:12px 24px;font-size:12px;color:#666;border-top:1px solid #eee">' +
    "Mad Vervet Hostel — Addis Ababa &amp; Nairobi — https://madvervet.com</div></div></div>"
  );
}

function rows(pairs) {
  return '<table style="width:100%;border-collapse:collapse">' + pairs.map(function (p) {
    return "<tr><td style='padding:6px 8px;font-weight:bold;vertical-align:top;width:40%'>" +
      esc(p[0]) + "</td><td style='padding:6px 8px'>" + esc(p[1]) + "</td></tr>";
  }).join("") + "</table>";
}

module.exports = { sendEmail, shell, rows, esc, hostelEmail, FROM };
