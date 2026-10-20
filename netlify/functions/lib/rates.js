/* Server-side room rates (data/room-rates.json) — the trusted price source while
   the PMS pricing API is unavailable. The browser also fetches this same file as
   its display fallback, so the price shown is the price charged.
   Rate shape per location → roomId:
     { "bed": n }                 dorm — priced per guest per night
     { "single": n }              private room, single occupancy only
     { "single": n, "double": n } private room — double rate when guests >= 2
   "amenities" holds the add-on prices (airportPickup flat, breakfastPerDayPerGuest
   × nights × guests, laundry flat).
   Updates: edit data/room-rates.json and redeploy (git push). The production
   functions filesystem is read-only, same constraint as data/promo-codes.json. */
const fs = require("fs");
const path = require("path");
const { round2 } = require("./promo");

const RATES_PATH = path.join(__dirname, "..", "..", "..", "data", "room-rates.json");
const MAX_GUESTS = 20; // sanity cap — guest count only ever raises the price

let CACHE = null;

function loadRates() {
  if (CACHE) return CACHE;
  try {
    CACHE = JSON.parse(fs.readFileSync(RATES_PATH, "utf8"));
  } catch (e) {
    console.warn("Could not read room-rates.json:", e.message);
    CACHE = null;
  }
  return CACHE;
}

/* Recomputes a booking's subtotal from the rates table — client-supplied amounts
   are never used for charging. Returns { subtotal } or { error }. */
function computeSubtotal(b) {
  const rates = loadRates();
  if (!rates) return { error: "Rates unavailable." };
  const locRates = rates[b.location];
  if (!locRates) return { error: "Unknown location." };
  const entry = locRates[b.roomId];
  if (!entry) return { error: "Unknown room." };
  const ms = new Date(b.checkOut) - new Date(b.checkIn);
  const nights = ms > 0 ? Math.round(ms / 86400000) : 0;
  if (!(nights >= 1)) return { error: "Invalid dates." };
  let guests = Math.min(Math.max(Number(b.guests) || 1, 1), MAX_GUESTS);
  let nightly, units;
  if (entry.bed != null) {
    nightly = entry.bed;
    units = guests;
  } else {
    guests = Math.min(guests, entry.double != null ? 2 : 1);
    nightly = guests >= 2 && entry.double != null ? entry.double : entry.single;
    if (nightly == null) return { error: "No rate for this room." };
    units = 1;
  }
  let subtotal = nightly * nights * units;
  const flags = b.amenities || {};
  const prices = rates.amenities || {};
  if (flags.airportPickup) subtotal += prices.airportPickup || 0;
  if (flags.breakfast) subtotal += (prices.breakfastPerDayPerGuest || 0) * nights * guests;
  if (flags.laundry) subtotal += prices.laundry || 0;
  return { subtotal: round2(subtotal) };
}

module.exports = { loadRates, computeSubtotal };
