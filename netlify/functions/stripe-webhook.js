/* stripe-webhook — verifies the Stripe signature, then for completed prepay
   checkouts (reconstructed from session metadata): enters the booking in the
   PMS (lib/pms.js) and emails booking details. If the PMS entry fails or is
   partial, the emails still go out with a manual-entry note for staff.
   Increments a promo code's usedCount ONLY when session metadata says the
   promo was the discount actually applied (not when the 10% prepay won). */
const Stripe = require("stripe");
const { sendBookingEmails } = require("./lib/booking");
const { incrementUsed } = require("./lib/promo");
const { createPmsBookings, getRoomInfo, PROPERTY_CODES } = require("./lib/pms");

const STRIPE_API_VERSION = "2024-06-20";

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function bookingFromMetadata(m) {
  m = m || {};
  const am = String(m.amenities || "");
  return {
    location: m.location, roomType: m.roomType,
    checkIn: m.checkIn, checkOut: m.checkOut,
    guests: Number(m.guests) || 1,
    amenities: {
      airportPickup: am.includes("airportPickup"),
      breakfast: am.includes("breakfast"),
      laundry: am.includes("laundry")
    },
    guest: { name: m.guestName || "", email: m.guestEmail || "", phone: m.guestPhone || "" },
    specialRequests: m.specialRequests || "",
    subtotal: Number(m.subtotal) || 0,
    paymentOption: "prepay",
    prepayDiscountApplied: true,
    promoCode: m.promoCode || null,
    promoDiscount: Number(m.discountAmount) || 0,
    promoDiscountApplied: m.discountApplied === "promo" && !!m.promoCode,
    amountChargedNow: 0, // filled from amount_total below
    amountDueAtCheckIn: 0
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!secret || !key) return json(500, { error: "Webhook not configured" });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
  const stripe = Stripe(key, { apiVersion: STRIPE_API_VERSION });
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(raw, event.headers["stripe-signature"] || "", secret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return json(400, { error: "Invalid signature" });
  }
  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;
    const booking = bookingFromMetadata(session.metadata);
    booking.amountChargedNow = (session.amount_total || 0) / 100;
    if (booking.promoDiscountApplied) incrementUsed(booking.promoCode);
    await sendBookingEmails(booking, session.id, await enterInPms(booking, session));
  }
  return json(200, { received: true });
};

/* Enters a paid booking in the PMS (room + category resolved from
   data/rooms.json — client metadata is not trusted for this). Returns the
   hostel-note line for the notification email. */
async function enterInPms(booking, session) {
  const paid = "Paid online via Stripe (session " + session.id + ").";
  const info = getRoomInfo(booking.location, session.metadata && session.metadata.roomId);
  const propertyCode = PROPERTY_CODES[booking.location];
  if (!info || !propertyCode) {
    return paid + " Could NOT be entered in the PMS automatically (unmapped room/location) — please add it manually.";
  }
  const units = info.category === "dorm" ? booking.guests : 1;
  const result = await createPmsBookings({
    propertyCode, category: info.category, roomNames: info.cmsRooms, units,
    checkIn: booking.checkIn, checkOut: booking.checkOut, guest: booking.guest
  });
  if (result.failed === 0) {
    return paid + " Entered in the PMS — booking IDs: " + result.booked.join(", ") + ".";
  }
  return "PAID online via Stripe (session " + session.id + ") — NOT fully entered in the PMS (" +
    result.booked.length + " of " + units + " units booked" +
    (result.booked.length ? ": " + result.booked.join(", ") : "") +
    "). Please add the missing unit(s) manually and contact the guest if the room is sold out.";
}
