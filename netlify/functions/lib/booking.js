/* Booking-shaped helpers: locations, reference IDs, and the two booking emails
   (hostel notification + guest confirmation) shared by reserve/prepay/webhook. */
const { sendEmail, shell, rows, hostelEmail } = require("./email");

const LOCATIONS = {
  "addis-ababa": {
    name: "Addis Ababa",
    address: "Downtown Bole, BL_03_552 St, Hayahulet, Addis Ababa, Ethiopia",
    phone: "+251 923 577 808"
  },
  nairobi: {
    name: "Nairobi",
    address: "Lavington neighborhood, Nairobi, Kenya (exact street address shared before arrival)",
    phone: "+251 923 577 808 (WhatsApp)"
  }
};

function money(n) {
  return "$" + Number(n || 0).toFixed(2);
}

function bookingRef() {
  return "MV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

function amenityList(a) {
  a = a || {};
  const on = [];
  if (a.airportPickup) on.push("Airport pickup");
  if (a.breakfast) on.push("Breakfast");
  if (a.laundry) on.push("Laundry");
  return on.length ? on.join(", ") : "None";
}

function bookingRows(b, ref) {
  const loc = LOCATIONS[b.location] || { name: b.location };
  return [
    ["Reference", ref],
    ["Guest", (b.guest && b.guest.name) || ""],
    ["Email", (b.guest && b.guest.email) || ""],
    ["Phone", (b.guest && b.guest.phone) || ""],
    ["Location", loc.name],
    ["Room", b.roomType],
    ["Check-in", b.checkIn],
    ["Check-out", b.checkOut],
    ["Guests", String(b.guests)],
    ["Amenities", amenityList(b.amenities)],
    ["Special requests", b.specialRequests || "—"],
    ["Subtotal", money(b.subtotal)],
    ["Promo code", b.promoDiscountApplied && b.promoCode
      ? b.promoCode + " (−" + money(b.promoDiscount) + ")"
      : "—"],
    ["Payment option", b.paymentOption],
    ["Charged now", money(b.amountChargedNow)],
    ["Due at check-in", money(b.amountDueAtCheckIn)]
  ];
}

function paymentLine(b) {
  if (b.paymentOption === "prepay") {
    const label = b.promoDiscountApplied && b.promoCode
      ? "promo code " + b.promoCode + " (−" + money(b.promoDiscount) + ") applied"
      : "10% prepay discount applied";
    return "Your payment of " + money(b.amountChargedNow) + " (" + label + ") " +
      "has been received in full — nothing is due at check-in.";
  }
  const promo = b.promoDiscountApplied && b.promoCode
    ? " after promo code " + b.promoCode + " (−" + money(b.promoDiscount) + ")"
    : "";
  return "Your reservation is confirmed — the amount of " + money(b.amountDueAtCheckIn) +
    promo + " is due at check-in (cash or card).";
}

function guestBody(b, ref) {
  const loc = LOCATIONS[b.location] || {};
  return "<p>Hi " + ((b.guest && b.guest.name) || "traveller") + ",</p><p><strong>" +
    paymentLine(b) + "</strong></p>" + rows(bookingRows(b, ref)) +
    "<p><strong>Find us:</strong><br>" + (loc.address || "") + "<br>Phone: " + (loc.phone || "") + "</p>" +
    '<p>Cancellation policy: <a href="https://madvervet.com/terms.html">madvervet.com/terms.html</a></p>' +
    "<p>See you soon — the Mad Vervet crew</p>";
}

async function sendBookingEmails(booking, ref) {
  const subject = "Booking " + ref + " — " + booking.roomType + " (" + booking.checkIn + " → " + booking.checkOut + ")";
  await sendEmail({
    to: hostelEmail(),
    subject: "[Mad Vervet] New " + booking.paymentOption + " booking " + ref,
    html: shell("New booking: " + ref, rows(bookingRows(booking, ref)))
  });
  if (booking.guest && booking.guest.email) {
    await sendEmail({ to: booking.guest.email, subject, html: shell("Booking confirmed — " + ref, guestBody(booking, ref)) });
  }
}

module.exports = { LOCATIONS, bookingRef, sendBookingEmails, money };
