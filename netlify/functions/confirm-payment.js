/* confirm-payment — fallback confirmation for prepaid bookings.

   The Stripe webhook (stripe-webhook.js) is the primary sender of booking
   emails, but if that webhook is misconfigured or delayed the guest would
   otherwise never get a confirmation. The payment success page
   (booking-confirmation.html?type=prepay) calls this function with the
   Checkout Session id; we re-fetch the session server-side, confirm it is
   actually paid, and send the two confirmation emails. Email-only by design —
   the PMS entry stays the webhook's job so a delayed webhook can't create
   duplicate bookings. Idempotent via the session metadata emailsSent flag. */
const Stripe = require("stripe");
const { bookingFromSession, sendPrepayEmails } = require("./lib/prepay");

const STRIPE_API_VERSION = "2024-06-20";

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function readSessionId(event) {
  if (event.httpMethod === "POST") {
    try {
      const id = JSON.parse(event.body || "{}").sessionId;
      if (id) return String(id);
    } catch (e) { /* fall through to query param */ }
  }
  const q = event.queryStringParameters || {};
  return String(q.sessionId || q.ref || "");
}

exports.handler = async (event) => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json(500, { error: "Payment not configured" });

  const sessionId = readSessionId(event);
  if (!sessionId) return json(400, { error: "Missing session id." });

  const stripe = Stripe(key, { apiVersion: STRIPE_API_VERSION });
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    console.error("confirm-payment: could not retrieve session " + sessionId + ":", err.message);
    return json(404, { error: "Session not found" });
  }

  if (session.mode !== "payment" || session.payment_status !== "paid") {
    return json(200, { ok: true, paid: false });
  }

  const booking = bookingFromSession(session);
  const hostelNote = "Paid online via Stripe (session " + session.id + "). " +
    "Confirmation sent via the payment-page fallback — please verify the booking is in " +
    "the PMS and add it manually if the webhook did not run.";
  const result = await sendPrepayEmails({ stripe, session, booking, hostelNote });
  return json(200, { ok: true, paid: true, sent: result.sent, alreadySent: result.alreadySent });
};
