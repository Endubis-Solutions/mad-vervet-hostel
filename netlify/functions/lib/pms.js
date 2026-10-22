/* PMS client — creates bookings at pms.madvervet.com after a Stripe payment
   completes (used by stripe-webhook). The PMS books ONE unit per call: dorms
   one bed per guest, private rooms one room. Bookings target a specific
   physical room via `roomCategory` (a PMS room name from the website room's
   cmsRooms list, picked from live availability) — required when one PMS
   category spans multiple price points (Nairobi's two mixed dorms) and for
   Single Rooms (PMS category "single"). The PMS accepts exactly one of
   roomCategory / roomType; if availability can't be fetched we fall back to
   coarse roomType booking. Never throws — the caller always sends the
   confirmation emails, with a manual-entry note when the PMS entry is missing
   or partial (sold-out mid-way, API down). */

const PMS_BASE = process.env.PMS_BASE_URL || "https://pms.madvervet.com";
const PROPERTY_CODES = { "addis-ababa": "ADD", nairobi: "NBO" };

/* Fetch with up to 3 attempts (backoff after each) — rides out brief PMS
   restarts before declaring the entry partial/manual. 4xx validation errors
   (400) and sold-out (409) are definitive and returned immediately without
   retrying; 408 (timeout) and 429 (rate-limit) are transient along with 5xx. */
function fetchWithRetry(url, options) {
  let attempts = 0;
  function attempt() {
    attempts++;
    return fetch(url, options).then((res) => {
      if (attempts < 3 && (res.status === 408 || res.status === 429 || res.status >= 500)) {
        return new Promise((r) => setTimeout(r, 800 * attempts)).then(attempt);
      }
      return res;
    }, (err) => {
      if (attempts >= 3) return Promise.reject(err);
      return new Promise((r) => setTimeout(r, 800 * attempts)).then(attempt);
    });
  }
  return attempt();
}

// Website room catalog — require()'d so Netlify's esbuild bundler inlines it.
const ROOMS = (function () {
  try {
    // eslint-disable-next-line global-require
    return require("../../../data/rooms.json");
  } catch (e) {
    console.warn("Could not load rooms.json:", e.message);
    return null;
  }
})();

/* Looks up a website room by location + roomId → { category, cmsRooms }. */
function getRoomInfo(location, roomId) {
  const loc = ROOMS && ROOMS[location];
  if (!loc) return null;
  const room = (loc.rooms || []).find((r) => r.id === roomId);
  return room ? { category: room.category, cmsRooms: room.cmsRooms || [] } : null;
}

/* Assigns each unit to a physical room name using live PMS availability.
   Returns an array of room names (length === units), or null when
   availability can't be fetched or there aren't enough free units. */
async function planAssignments(propertyCode, roomNames, units, checkIn, checkOut) {
  if (!roomNames || !roomNames.length) return null;
  try {
    const res = await fetchWithRetry(PMS_BASE + "/api/availability?propertyCode=" +
      encodeURIComponent(propertyCode) + "&checkIn=" + encodeURIComponent(checkIn) +
      "&checkOut=" + encodeURIComponent(checkOut));
    if (!res.ok) throw new Error("availability " + res.status);
    const data = await res.json();
    const free = {};
    (data.beds || []).forEach((b) => {
      if (roomNames.indexOf(b.roomName) !== -1) free[b.roomName] = (free[b.roomName] || 0) + 1;
    });
    const assignments = [];
    for (let i = 0; i < units; i++) {
      const target = roomNames.find((n) => (free[n] || 0) > 0);
      if (!target) return null;
      free[target]--;
      assignments.push(target);
    }
    return assignments;
  } catch (e) {
    console.warn("PMS availability fetch failed (falling back to roomType booking):", e.message);
    return null;
  }
}

async function createPmsBookings({ propertyCode, category, roomNames, units, checkIn, checkOut, guest }) {
  const assignments = await planAssignments(propertyCode, roomNames, units, checkIn, checkOut);
  const booked = [];
  for (let i = 0; i < units; i++) {
    // The PMS requires exactly one of roomCategory / roomType.
    const payload = {
      propertyCode,
      checkIn,
      checkOut,
      guest: {
        fullName: (guest && guest.name) || "",
        guestEmail: (guest && guest.email) || "",
        phone: (guest && guest.phone) || ""
      }
    };
    if (assignments && assignments[i]) payload.roomCategory = assignments[i];
    else payload.roomType = category === "private" ? "private" : "dorm";
    try {
      // Do not retry booking POSTs: a timeout/5xx can happen after the PMS
      // created the booking, so retrying could create a duplicate.
      const res = await fetch(PMS_BASE + "/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.status === 201) {
        const data = await res.json().catch(() => ({}));
        booked.push(data.bookingId || "unknown-id");
      } else {
        console.warn("PMS booking failed (" + res.status + "):", await res.text().catch(() => ""));
        break; // 409 sold out or bad request — remaining units would fail too
      }
    } catch (e) {
      console.warn("PMS booking request error:", e.message);
      break; // API unreachable — remaining units would fail too
    }
  }
  return { booked, failed: units - booked.length };
}

module.exports = { createPmsBookings, getRoomInfo, PROPERTY_CODES, PMS_BASE };
