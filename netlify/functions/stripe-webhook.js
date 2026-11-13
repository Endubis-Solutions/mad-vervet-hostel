/* stripe-webhook — verifies the Stripe signature, then for completed prepay
   checkouts (reconstructed from session metadata): enters the booking in the
   PMS (lib/pms.js) and emails booking details. If the PMS entry fails or is
   partial, the emails still go out with a manual-entry note for staff.
   Increments a promo code's usedCount ONLY when session metadata says the
   promo was the discount actually applied (not when the 10% prepay won). */
const Stripe = require("stripe");
const { bookingFromSession, flagSet, setSessionFlag, sendPrepayEmails } = require("./lib/prepay");
const { incrementUsed } = require("./lib/promo");
const { createPmsBookings, getRoomInfo, PROPERTY_CODES } = require("./lib/pms");

const STRIPE_API_VERSION = "2024-06-20";

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
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
    const session = await retrieveSession(stripe, stripeEvent.data.object);
    const booking = bookingFromSession(session);

    // Enter in the PMS exactly once (idempotent across webhook retries).
    let hostelNote = "";
    if (!flagSet(session, "pmsEntered")) {
      hostelNote = await enterInPms(booking, session);
      await setSessionFlag(stripe, session.id, session.metadata, "pmsEntered");
    } else {
      hostelNote = "Paid online via Stripe (session " + session.id + "). Already entered in the PMS.";
    }

    // Send the confirmation emails exactly once (idempotent; the success-page
    // fallback may have already sent them).
    const sent = await sendPrepayEmails({ stripe, session, booking, hostelNote });
    if (sent.sent && booking.promoDiscountApplied) incrementUsed(booking.promoCode);
  }
  return json(200, { received: true });
};

/* Re-fetches the Checkout Session fresh so the dedupe flags (written to session
   metadata by this function or the success-page fallback) are visible even on
   Stripe webhook retries, where the event snapshot would otherwise be stale.
   Falls back to the event snapshot if the retrieve call fails. */
async function retrieveSession(stripe, eventSession) {
  try {
    return await stripe.checkout.sessions.retrieve(eventSession.id);
  } catch (err) {
    console.warn("stripe-webhook: could not re-retrieve session " + eventSession.id +
      ", using event snapshot:", err.message);
    return eventSession;
  }
}

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
    propertyCode, category: info.category, roomNames: info.cmsRooms, categoryCode: info.categoryCode, units,
    checkIn: booking.checkIn, checkOut: booking.checkOut, guest: booking.guest,
    extras: { guests: booking.guests, amountChargedNow: booking.amountChargedNow, sessionId: session.id }
  });
  if (result.failed === 0) {
    return paid + " Entered in the PMS — booking IDs: " + result.booked.join(", ") + ".";
  }
  return "PAID online via Stripe (session " + session.id + ") — NOT fully entered in the PMS (" +
    result.booked.length + " of " + units + " units booked" +
    (result.booked.length ? ": " + result.booked.join(", ") : "") +
    "). Please add the missing unit(s) manually and contact the guest if the room is sold out.";
}
