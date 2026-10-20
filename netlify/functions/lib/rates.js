/* Server-side room rates (data/room-rates.json) — the trusted price source while
   the PMS pricing API is unavailable. The browser also fetches this same file as
   its display fallback, so the price shown is the price charged.
   Rate shape per location → roomId:
     { "bed": n }                 dorm — priced per guest per night
     { "single": n }              private room, single occupancy only
     { "single": n, "double": n } private room — double rate when guests >= 2
   "amenities" holds the add-on prices (airportPickup flat, breakfastPerDayPerGuest
   × nights × guests, laundry flat).
   Loading: the JSON is require()'d so Netlify's esbuild bundler inlines it into
   the function bundle (fs.readFileSync + __dirname paths break under esbuild —
   the bundled layout differs from the repo layout). The fs fallbacks cover
   nft-style bundling and plain node. Updates: edit data/room-rates.json and
   redeploy (git push). */
const fs = require("fs");
const path = require("path");
const { round2 } = require("./promo");

const MAX_GUESTS = 20; // sanity cap — guest count only ever raises the price

let CACHE = null;

function loadRates() {
  if (CACHE) return CACHE;
  try {
    // eslint-disable-next-line global-require
    CACHE = require("../../../data/room-rates.json");
    return CACHE;
  } catch (e) { /* fall through to fs candidates */ }
  const candidates = [
    path.join(__dirname, "..", "..", "..", "data", "room-rates.json"),
    path.join(process.cwd(), "data", "room-rates.json")
  ];
  for (const p of candidates) {
    try {
      CACHE = JSON.parse(fs.readFileSync(p, "utf8"));
      return CACHE;
    } catch (e) { /* try next */ }
  }
  console.warn("Could not load room-rates.json from:", candidates.join(", "));
  CACHE = null;
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
