/* validate-promo — checks a promo code against data/promo-codes.json.
   POST { code, location, subtotal? } → { valid, code?, type?, value?, appliesTo?, error? }.
   Read-only: NEVER increments usedCount (that happens only on confirmed bookings). */
const { validateCode } = require("./lib/promo");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { valid: false, error: "Invalid JSON body" });
  }
  if (!body.code || !String(body.code).trim()) {
    return json(400, { valid: false, error: "Please enter a promo code." });
  }
  const v = validateCode(body.code, body.location || "");
  if (!v.valid) return json(200, { valid: false, error: v.error });
  return json(200, {
    valid: true,
    code: v.promo.code,
    type: v.promo.type,
    value: v.promo.value,
    appliesTo: v.promo.appliesTo
  });
};
