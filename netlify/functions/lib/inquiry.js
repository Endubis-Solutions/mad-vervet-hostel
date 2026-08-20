/* Shared factory for simple inquiry endpoints (tour / group / contact).
   Sends one notification email to the hostel + one auto-reply to the sender. */
const { sendEmail, shell, rows, esc, hostelEmail } = require("./email");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function validate(data, required) {
  for (const key of required) {
    if (!String(data[key] || "").trim()) return "Missing required field: " + key;
  }
  if (!EMAIL_RE.test(String(data.email || ""))) return "Invalid email address.";
  return null;
}

function inquiryHandler({ kind, required, labels }) {
  return async (event) => {
    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
    let data;
    try {
      data = JSON.parse(event.body || "{}");
    } catch (e) {
      return json(400, { error: "Invalid JSON body" });
    }
    const err = validate(data, required);
    if (err) return json(400, { error: err });
    const pairs = Object.keys(labels).map((k) => [labels[k], data[k] || "—"]);
    await sendEmail({
      to: hostelEmail(),
      subject: "[Mad Vervet] " + kind + " inquiry from " + data.name,
      html: shell(kind + " inquiry", rows(pairs))
    });
    await sendEmail({
      to: data.email,
      subject: "Thanks for your " + kind.toLowerCase() + " inquiry — Mad Vervet Hostel",
      html: shell("We got your message",
        "<p>Hi " + esc(data.name) + ",</p><p>Thanks for reaching out about <strong>" +
        esc(kind.toLowerCase()) + "</strong>. We'll get back to you within 24 hours.</p>" +
        "<p>— the Mad Vervet crew</p>")
    });
    return json(200, { ok: true });
  };
}

module.exports = { inquiryHandler };
