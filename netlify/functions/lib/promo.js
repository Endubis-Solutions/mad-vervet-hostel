/* Promo code helpers shared by the booking functions.
   Code semantics (see data/promo-codes.json):
     type "percent": value = % off the subtotal; "flat": fixed $ off (capped at subtotal).
     appliesTo "all"/"rooms": valid for any location. ("rooms" is kept simple for
       now — the discount is computed off the whole subtotal; splitting room cost
       from amenities is a future refinement.)
     appliesTo "<location-slug>": valid only for that location.
   Usage counts persist in a Netlify Blobs store ("promo-usage") — that's what
   makes maxUses (e.g. single-use codes) enforceable in production. Outside
   Netlify (plain `node`, no blob context) the counters fall back to the
   JSON file's usedCount with best-effort file writes (dev only). The effective
   count is the MAX of the two sources so neither can undercount.
   Reads of the JSON try several candidate paths: Netlify's esbuild bundler
   does not preserve the repo directory layout, so a single __dirname-relative
   path misses the included file in production. */
const fs = require("fs");
const path = require("path");

const CODES_CANDIDATES = [
  path.join(__dirname, "..", "..", "..", "data", "promo-codes.json"),
  path.join(process.cwd(), "data", "promo-codes.json"),
  "/var/task/data/promo-codes.json"
];

let codesPath = null;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function findCodesPath() {
  if (codesPath) return codesPath;
  for (const p of CODES_CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      codesPath = p;
      return p;
    } catch (e) { /* try next */ }
  }
  return null;
}

function loadCodes() {
  const p = findCodesPath();
  if (!p) {
    console.warn("Could not find promo-codes.json in:", CODES_CANDIDATES.join(", "));
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn("Could not read promo-codes.json:", e.message);
    return [];
  }
}

/* The Blobs store holding per-code usage counters (text values). Returns
   null outside Netlify (plain node) so callers fall back to the JSON file. */
function usageStore() {
  try {
    // eslint-disable-next-line global-require
    const { getStore } = require("@netlify/blobs");
    return getStore("promo-usage");
  } catch (e) {
    return null;
  }
}

/* Effective times a code has been redeemed: max(Blobs counter, JSON
   usedCount). Falls back to the JSON value when Blobs is unreachable so a
   store hiccup never makes a used single-use code look fresh. */
async function usedCountOf(promo) {
  const fileCount = Number(promo.usedCount) || 0;
  const store = usageStore();
  if (!store) return fileCount;
  try {
    const blob = Number(await store.get(promo.code, { type: "text" })) || 0;
    return Math.max(blob, fileCount);
  } catch (e) {
    console.warn("promo usage read failed, using file count:", e.message);
    return fileCount;
  }
}

async function codeError(promo, location) {
  if (!promo) return "Unknown promo code.";
  const today = new Date().toISOString().slice(0, 10);
  if (promo.expires && promo.expires < today) return "This promo code has expired.";
  if (promo.maxUses != null && (await usedCountOf(promo)) >= promo.maxUses) {
    return "This promo code has been fully used.";
  }
  if (["all", "rooms"].indexOf(promo.appliesTo) === -1 && promo.appliesTo !== location) {
    return "This code is not valid for this location.";
  }
  return null;
}

async function validateCode(code, location) {
  const wanted = String(code || "").trim().toUpperCase();
  const promo = loadCodes().find((c) => c.code === wanted);
  const error = await codeError(promo, location);
  return error ? { valid: false, error } : { valid: true, promo };
}

function computeDiscount(promo, subtotal) {
  const raw = promo.type === "percent"
    ? Number(subtotal) * (promo.value / 100)
    : Math.min(promo.value, Number(subtotal));
  return round2(Math.max(0, Math.min(raw, Number(subtotal))));
}

/* Prepay comparison — returns the single winning discount (never stacked):
   the larger of the 10% prepay discount vs the promo. The 10% prepay discount
   only applies when the guest books PREPAY_ADVANCE_DAYS+ days before check-in
   (last-minute bookings can still pay online, but get no discount). Promo
   codes apply regardless of lead time. { error } if the promo is invalid. */
const PREPAY_ADVANCE_DAYS = 3;

function daysFromToday(dateStr) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = dateStr ? new Date(dateStr + "T00:00:00Z").getTime() : NaN;
  if (!Number.isFinite(target)) return 0;
  return Math.round((target - today) / 86400000);
}

function prepayDiscountEligible(checkIn) {
  return daysFromToday(checkIn) >= PREPAY_ADVANCE_DAYS;
}

async function resolvePrepayDiscount(promoCode, location, subtotal, checkIn) {
  const prepay = prepayDiscountEligible(checkIn) ? round2(Number(subtotal) * 0.1) : 0;
  if (!promoCode) {
    return prepay > 0
      ? { amount: prepay, applied: "prepay10", promoCode: null }
      : { amount: 0, applied: "none", promoCode: null };
  }
  const v = await validateCode(promoCode, location);
  if (!v.valid) return { error: v.error };
  const promo = computeDiscount(v.promo, subtotal);
  if (promo > prepay) return { amount: promo, applied: "promo", promoCode: v.promo.code };
  return prepay > 0
    ? { amount: prepay, applied: "prepay10", promoCode: null }
    : { amount: 0, applied: "none", promoCode: null };
}

/* Marks a code as redeemed. Persists to the Blobs counter (production);
   also bumps the JSON file's usedCount when that's writable (netlify dev).
   Wrapped in try/catch so a persistence failure can never break a confirmed
   booking. */
async function incrementUsed(code) {
  try {
    const promo = loadCodes().find((c) => c.code === code);
    const store = usageStore();
    if (store) {
      const current = promo ? await usedCountOf(promo) : (Number(await store.get(code, { type: "text" })) || 0);
      await store.set(code, String(current + 1));
    }
  } catch (e) {
    console.warn("promo usage persist (blobs) failed:", e.message);
  }
  try {
    const p = findCodesPath();
    if (!p) return;
    const codes = loadCodes();
    const promo = codes.find((c) => c.code === code);
    if (!promo) return;
    promo.usedCount = (promo.usedCount || 0) + 1;
    fs.writeFileSync(p, JSON.stringify(codes, null, 2) + "\n");
  } catch (e) {
    console.warn("promo usedCount file persist skipped (read-only fs in production):", e.message);
  }
}

module.exports = { validateCode, computeDiscount, resolvePrepayDiscount, incrementUsed, round2, prepayDiscountEligible };
