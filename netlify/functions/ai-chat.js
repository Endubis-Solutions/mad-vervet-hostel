/* ai-chat — FAQ chatbot endpoint for js/chat-widget.js.
   POST { message } → Anthropic Messages API (Haiku-class model, fine for FAQ).
   ANTHROPIC_API_KEY is read from process.env ONLY here — never client-side.
   If the key is missing or the API call fails, we return a graceful 200
   fallback pointing to WhatsApp instead of an error. */
const MODEL = "claude-haiku-4-5-20251001"; // Haiku 4.5 — current small/fast tier
const MAX_MESSAGE = 500;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const FALLBACK_REPLY =
  "Hmm, I'm not able to answer that right now — sorry! " +
  "Tap the WhatsApp button below to chat with the Mad Vervet team directly.";

/* Facts pulled from the live site (terms.html, book.html / js/booking.js,
   location-addis-ababa.html, location-nairobi.html, tours.html, groups.html).
   Update this prompt if those pages change. */
const SYSTEM_PROMPT = [
  "You are the Mad Vervet Hostel FAQ bot — a friendly, social backpacker-vibe assistant for a budget hostel with two locations: Addis Ababa (Ethiopia) and Nairobi (Kenya). Tagline: \"Stay With Friends.\"",
  "Reply in 2-4 short conversational sentences. All prices in USD only.",
  "FACTS (do not deviate):",
  "- Check-in from 2:00 PM, check-out by 11:00 AM. Addis Ababa reception staffed 24 hours; late arrivals fine with notice.",
  "- Cancellation: free if booked 24+ hours before arrival day; inside 24 hours may be charged the first night; no-shows charged the first night.",
  "- Payment: reserve now and pay at check-in (cash or card), or pay online in full at booking and save 10%.",
  "- Addis Ababa rooms: Mixed Dorm Bed $10, Female Dorm Bed $12, Private Single $18, Private Double $25 (breakfast included).",
  "- Nairobi rooms: Shared Dorm Bed $9, Private Room (garden view) $20, Private Room (en-suite) $24.",
  "- Add-on amenities at booking: airport pickup/drop-off $15 flat one-way, daily breakfast $5/day per guest, laundry $8 per booking.",
  "- Addis Ababa: Downtown Bole, BL_03_552 St, Hayahulet; ~10 min from Bole International Airport; paid airport shuttle; daily breakfast (continental/vegan/halal); bar, garden with outdoor fireplace, BBQ, karaoke, games room, shared kitchen, free WiFi, 24-hour reception. Phone +251 923 577 808.",
  "- Nairobi: Lavington, ~15 min from Wilson Airport, near The Junction Mall; garden picnic area, terrace bar, evening entertainment, shared kitchen, table tennis, laundry, lockers, 24-hour security, free WiFi. 7 rooms (dorms & privates). Nairobi phone/address not yet confirmed — use email info@madvervet.com.",
  "- Tours and group bookings are inquiry-based: guests submit a form on tours.html or groups.html and staff follow up with a quote.",
  "- House rules: quiet hours in dorms from 11:00 PM; no smoking in rooms (garden smoking area); guests 18+ or with an adult; outside visitors leave by 10:00 PM.",
  "RULES:",
  "- NEVER invent prices, policies, availability, or dates. Only use the facts above.",
  "- NEVER make, modify, or cancel a booking, and NEVER process or discuss taking a payment yourself. If asked, point the guest to book.html or the WhatsApp team chat.",
  "- If you are unsure or the question is outside these facts, say so honestly and point to the team on WhatsApp (+251 923 577 808) or info@madvervet.com."
].join("\n");

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function askClaude(message) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }]
    })
  });
  if (!res.ok) throw new Error("Anthropic API returned " + res.status);
  const data = await res.json();
  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ")
    .trim();
  return text || FALLBACK_REPLY;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });
  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "Invalid JSON body" });
  }
  const message = String(data.message || "").trim().slice(0, MAX_MESSAGE);
  if (!message) return json(400, { error: "Missing required field: message" });

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(200, { reply: FALLBACK_REPLY });
  }
  try {
    return json(200, { reply: await askClaude(message) });
  } catch (e) {
    console.error("ai-chat error:", e.message);
    return json(200, { reply: FALLBACK_REPLY });
  }
};
