/* create-checkout-session — "prepay" path. The charged amount is computed
   server-side only: subtotal − max(10% prepay discount, promo discount) —
   the two never stack. Client amounts are never trusted. */
const Stripe = require("stripe");
const { resolvePrepayDiscount, round2 } = require("./lib/promo");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRIPE_API_VERSION = "2024-06-20";

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function validate(b) {
  if (!b || typeof b !== "object") return "Invalid payload.";
  if (b.paymentOption !== "prepay") return "paymentOption must be 'prepay'.";
  if (!b.location || !b.roomType || !b.checkIn || !b.checkOut) return "Missing booking details.";
  if (!(Number(b.guests) >= 1)) return "Guests must be at least 1.";
  if (!(Number(b.subtotal) > 0)) return "Invalid subtotal.";
  const g = b.guest || {};
  if (!g.name || !g.phone || !EMAIL_RE.test(g.email || "")) return "Missing guest details.";
  return null;
}

function baseUrl(event) {
  const h = event.headers || {};
  const proto = h["x-forwarded-proto"] || "https";
  const host = h["x-forwarded-host"] || h.host || "madvervet.com";
  return proto + "://" + host;
}

function metadata(b) {
  const a = b.amenities || {};
  const g = b.guest || {};
  return {
    location: String(b.location), roomType: String(b.roomType),
    checkIn: String(b.checkIn), checkOut: String(b.checkOut),
    guests: String(b.guests), subtotal: String(b.subtotal),
    guestName: String(g.name || ""), guestEmail: String(g.email || ""), guestPhone: String(g.phone || ""),
    amenities: ["airportPickup", "breakfast", "laundry"].filter((k) => a[k]).join(",") || "none",
    specialRequests: String(b.specialRequests || "").slice(0, 490),
    promoCode: b._promo && b._promo.promoCode ? b._promo.promoCode : "",
    discountApplied: b._promo ? b._promo.applied : "prepay10",
    discountAmount: String(b._promo ? b._promo.amount : 0)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  if (!process.env.STRIPE_SECRET_KEY) return json(500, { error: "Payment not configured" });
  let booking;
  try {
    booking = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid JSON body" });
  }
  const err = validate(booking);
  if (err) return json(400, { error: err });
  const subtotal = Number(booking.subtotal);
  const disc = resolvePrepayDiscount(booking.promoCode, booking.location, subtotal);
  if (disc.error) return json(400, { error: "Promo code rejected: " + disc.error });
  booking._promo = disc; // { amount, applied: "prepay10"|"promo", promoCode }
  const charge = round2(subtotal - disc.amount);
  if (!(charge > 0)) return json(400, { error: "Invalid amount to charge." });
  const label = disc.applied === "promo" ? "promo code " + disc.promoCode : "10% prepay discount";
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  const base = baseUrl(event);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: booking.guest.email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: Math.round(charge * 100),
        product_data: { name: booking.roomType + " — " + booking.checkIn + " to " + booking.checkOut + " (" + label + ")" }
      }
    }],
    metadata: metadata(booking),
    success_url: base + "/booking-confirmation.html?type=prepay&ref={CHECKOUT_SESSION_ID}",
    cancel_url: base + "/book.html"
  });
  return json(200, { ok: true, checkoutUrl: session.url, ref: session.id });
};
