/* Promo code helpers shared by the booking functions.
   Code semantics (see data/promo-codes.json):
     type "percent": value = % off the subtotal; "flat": fixed $ off (capped at subtotal).
     appliesTo "all"/"rooms": valid for any location. ("rooms" is kept simple for
       now — the discount is computed off the whole subtotal; splitting room cost
       from amenities is a future refinement.)
     appliesTo "<location-slug>": valid only for that location.
   usedCount is persisted by writing the JSON file — this works in `netlify dev`
   but NOT in deployed production (read-only filesystem); incrementUsed never
   throws so a failed write can never break a confirmed booking.
   Reads try several candidate paths: Netlify's esbuild bundler does not preserve
   the repo directory layout, so a single __dirname-relative path misses the
   included file in production. */
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

function codeError(promo, location) {
  if (!promo) return "Unknown promo code.";
  const today = new Date().toISOString().slice(0, 10);
  if (promo.expires && promo.expires < today) return "This promo code has expired.";
  if (promo.maxUses != null && (promo.usedCount || 0) >= promo.maxUses) {
    return "This promo code has been fully used.";
  }
  if (["all", "rooms"].indexOf(promo.appliesTo) === -1 && promo.appliesTo !== location) {
    return "This code is not valid for this location.";
  }
  return null;
}

function validateCode(code, location) {
  const wanted = String(code || "").trim().toUpperCase();
  const promo = loadCodes().find((c) => c.code === wanted);
  const error = codeError(promo, location);
  return error ? { valid: false, error } : { valid: true, promo };
}

function computeDiscount(promo, subtotal) {
  const raw = promo.type === "percent"
    ? Number(subtotal) * (promo.value / 100)
    : Math.min(promo.value, Number(subtotal));
  return round2(Math.max(0, Math.min(raw, Number(subtotal))));
}

/* Prepay comparison — returns the single winning discount (never stacked):
   the larger of the 10% prepay discount vs the promo. { error } if promo invalid. */
function resolvePrepayDiscount(promoCode, location, subtotal) {
  const prepay = round2(Number(subtotal) * 0.1);
  if (!promoCode) return { amount: prepay, applied: "prepay10", promoCode: null };
  const v = validateCode(promoCode, location);
  if (!v.valid) return { error: v.error };
  const promo = computeDiscount(v.promo, subtotal);
  return promo > prepay
    ? { amount: promo, applied: "promo", promoCode: v.promo.code }
    : { amount: prepay, applied: "prepay10", promoCode: null };
}

/* DEV-ONLY persistence: writing the JSON fails on Netlify's read-only
   production filesystem. Wrapped in try/catch so it can never break a booking;
   production should move codes to a database/KV store (see README). */
function incrementUsed(code) {
  try {
    const p = findCodesPath();
    if (!p) return;
    const codes = loadCodes();
    const promo = codes.find((c) => c.code === code);
    if (!promo) return;
    promo.usedCount = (promo.usedCount || 0) + 1;
    fs.writeFileSync(p, JSON.stringify(codes, null, 2) + "\n");
  } catch (e) {
    console.warn("promo usedCount persist failed (read-only fs in production?):", e.message);
  }
}

module.exports = { validateCode, computeDiscount, resolvePrepayDiscount, incrementUsed, round2 };
