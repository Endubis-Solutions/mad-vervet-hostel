/* Server-side pricing — the PMS date-based rates (per check-in date) are the
   primary price source, with data/room-rates.json as the fallback when the
   pricing API is unreachable. The browser shows the same rates for the chosen
   check-in date, so the price shown is the price charged.
   Rate shape per location → roomId (fallback):
     { "bed": n }                 dorm — priced per guest per night
     { "single": n }              private room, single occupancy only
     { "single": n, "double": n } private room — double rate when guests >= 2
  "amenities" holds the add-on prices (airportPickup flat, breakfastPerDayPerGuest
   × nights × guests, laundry flat); "amenitiesByLocation" overrides individual
   amenity prices per location (e.g. Addis breakfast is $3, Nairobi $5).
   Loading: the JSON is require()'d so Netlify's esbuild bundler inlines it into
   the function bundle (fs.readFileSync + __dirname paths break under esbuild —
   the bundled layout differs from the repo layout). The fs fallbacks cover
   nft-style bundling and plain node. Updates: edit data/room-rates.json and
   redeploy (git push). */
const fs = require("fs");
const path = require("path");
const { round2 } = require("./promo");
const { getRoomInfo, PROPERTY_CODES, fetchPricing } = require("./pms");

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

/* Recomputes a booking's subtotal — client-supplied amounts are never used for
   charging. Date-based PMS rates (per check-in date) are preferred, falling back
   to the static rates table when the PMS is unreachable. Returns { subtotal } or
   { error }. */
async function computeSubtotal(b) {
  const ms = new Date(b.checkOut) - new Date(b.checkIn);
  const nights = ms > 0 ? Math.round(ms / 86400000) : 0;
  if (!(nights >= 1)) return { error: "Invalid dates." };
  const guests = Math.min(Math.max(Number(b.guests) || 1, 1), MAX_GUESTS);
  const rates = loadRates();

  let nightly = null;
  let units = 1;

  // 1) Date-based PMS pricing wins when the room resolves and the API responds.
  const byRoom = await fetchPricing(PROPERTY_CODES[b.location], b.checkIn);
  const room = getRoomInfo(b.location, b.roomId);
  if (byRoom && room) {
    let entry = null;
    (room.cmsRooms || []).forEach((name) => { if (!entry && byRoom[name]) entry = byRoom[name]; });
    if (entry) {
      if (room.category === "private") {
        const g = Math.min(guests, entry.double != null ? 2 : 1);
        nightly = g >= 2 && entry.double != null ? entry.double : entry.single;
        units = 1;
      } else {
        nightly = entry.bed != null ? entry.bed : entry.single;
        units = guests;
      }
    }
  }

  // 2) Fall back to the static rates table (data/room-rates.json).
  if (nightly == null) {
    const locRates = rates && rates[b.location];
    const entry = locRates && locRates[b.roomId];
    if (!entry) return { error: rates ? "Unknown room." : "Rates unavailable." };
    if (entry.bed != null) {
      nightly = entry.bed;
      units = guests;
    } else {
      const g = Math.min(guests, entry.double != null ? 2 : 1);
      nightly = g >= 2 && entry.double != null ? entry.double : entry.single;
      if (nightly == null) return { error: "No rate for this room." };
      units = 1;
    }
  }

  let subtotal = nightly * nights * units;
  const flags = b.amenities || {};
  const prices = Object.assign({}, (rates && rates.amenities) || {}, (rates && rates.amenitiesByLocation && rates.amenitiesByLocation[b.location]) || {});
  if (flags.airportPickup) subtotal += prices.airportPickup || 0;
  if (flags.breakfast) subtotal += (prices.breakfastPerDayPerGuest || 0) * nights * guests;
  if (flags.laundry) subtotal += prices.laundry || 0;
  return { subtotal: round2(subtotal) };
}

module.exports = { loadRates, computeSubtotal };
