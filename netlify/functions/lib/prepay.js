/* lib/prepay — shared helpers for the prepay (online payment) path.

   Both the Stripe webhook (primary) and the success-page fallback
   (confirm-payment.js) reconstruct the booking from the Checkout Session
   metadata and send the two confirmation emails. To keep the flow idempotent
   when both run (or when Stripe retries the webhook), the session metadata is
   used as a lightweight store of two flags:

     - pmsEntered : the webhook has created the booking in the PMS.
     - emailsSent : the confirmation emails have been sent.

   The flags live on the Stripe Checkout Session itself, so no database or
   writable filesystem is required. */
const { sendBookingEmails } = require("./booking");

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

function bookingFromSession(session) {
  const booking = bookingFromMetadata(session && session.metadata);
  booking.amountChargedNow = ((session && session.amount_total) || 0) / 100;
  return booking;
}

function flagSet(session, key) {
  return !!(session && session.metadata && session.metadata[key] === "true");
}

/* Marks a flag on the Checkout Session metadata. Merges existing metadata so
   other keys (guest details, promo, etc.) are preserved. Best-effort — a
   failure here is logged but must not block the booking or the email. */
async function setSessionFlag(stripe, sessionId, metadata, key) {
  try {
    await stripe.checkout.sessions.update(sessionId, {
      metadata: Object.assign({}, metadata || {}, { [key]: "true" })
    });
    return true;
  } catch (err) {
    console.warn("Could not set session flag " + key + " on " + sessionId + ":", err.message);
    return false;
  }
}

/* Sends the two confirmation emails once. If the success-page fallback (or a
   prior webhook attempt) already sent them, this is a no-op. */
async function sendPrepayEmails({ stripe, session, booking, hostelNote }) {
  if (flagSet(session, "emailsSent")) return { sent: false, alreadySent: true };
  await sendBookingEmails(booking, session.id, hostelNote);
  await setSessionFlag(stripe, session.id, session.metadata, "emailsSent");
  return { sent: true, alreadySent: false };
}

module.exports = { bookingFromMetadata, bookingFromSession, flagSet, setSessionFlag, sendPrepayEmails };
