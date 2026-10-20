/* send-confirmation — sends the two booking emails (hostel notification +
   guest confirmation) after a booking has been created in the PMS. The PMS is
   the source of truth: this function never creates bookings, it only emails.
   Expects the booking payload plus `refs` (the PMS booking IDs) — the refs
   become the email reference. Emailing is best-effort on the client; a
   failure here must not block the guest's confirmation page.
   The subtotal is recomputed from data/room-rates.json when the room is in the
   rates table — client amounts are never trusted for the emailed figures. */
const { sendBookingEmails } = require("./lib/booking");
const { computeSubtotal } = require("./lib/rates");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function validate(b) {
  if (!b || typeof b !== "object") return "Invalid payload.";
  if (!b.location || !b.roomType || !b.checkIn || !b.checkOut) return "Missing booking details.";
  if (!(Number(b.guests) >= 1)) return "Guests must be at least 1.";
  const g = b.guest || {};
  if (!g.name || !g.phone || !EMAIL_RE.test(g.email || "")) return "Missing guest details.";
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let booking;
  try {
    booking = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid JSON body" });
  }
  const err = validate(booking);
  if (err) return json(400, { error: err });
  const priced = computeSubtotal(booking);
  if (!priced.error) booking.subtotal = priced.subtotal;
  const refs = Array.isArray(booking.refs) ? booking.refs.filter(Boolean) : [];
  const ref = refs.length ? refs.join(", ") : "MV-PMS";
  await sendBookingEmails(booking, ref);
  return json(200, { ok: true, ref });
};
