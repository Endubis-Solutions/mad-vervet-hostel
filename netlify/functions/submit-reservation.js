/* submit-reservation — "reserve" path (pay at check-in). No Stripe here.
   If payload.promoCode is present it is re-validated server-side (expiry, uses,
   location) and the discount is recomputed from payload.subtotal — the client
   amounts are never trusted. An invalid promo code is a 400 (documented API
   behaviour), not a silent ignore. */
const { bookingRef, sendBookingEmails } = require("./lib/booking");
const { validateCode, computeDiscount, incrementUsed, round2 } = require("./lib/promo");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function validate(b) {
  if (!b || typeof b !== "object") return "Invalid payload.";
  if (b.paymentOption !== "reserve") return "paymentOption must be 'reserve'.";
  if (!b.location || !b.roomType || !b.checkIn || !b.checkOut) return "Missing booking details.";
  if (!(Number(b.guests) >= 1)) return "Guests must be at least 1.";
  if (!(Number(b.subtotal) > 0)) return "Invalid subtotal.";
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
  const subtotal = Number(booking.subtotal);
  booking.amountChargedNow = 0;
  booking.amountDueAtCheckIn = subtotal;
  booking.promoDiscountApplied = false;
  booking.promoDiscount = 0;
  if (booking.promoCode) {
    const v = validateCode(booking.promoCode, booking.location);
    if (!v.valid) return json(400, { error: "Promo code rejected: " + v.error });
    booking.promoCode = v.promo.code;
    booking.promoDiscount = computeDiscount(v.promo, subtotal);
    booking.promoDiscountApplied = booking.promoDiscount > 0;
    booking.amountDueAtCheckIn = round2(subtotal - booking.promoDiscount);
    incrementUsed(v.promo.code); // promo is the applied discount on the reserve path
  }
  const ref = bookingRef();
  await sendBookingEmails(booking, ref);
  return json(200, {
    ok: true,
    ref,
    redirectUrl: "/booking-confirmation.html?type=reserve&ref=" + encodeURIComponent(ref)
  });
};
