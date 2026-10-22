/* booking.js — room selection, live pricing and submission for book.html.
   Room data is loaded from data/rooms.json (later to be served by the CMS).
   Availability and bookings come from the live PMS at pms.madvervet.com:
     - availability : GET  {API_BASE}/api/availability?propertyCode=ADD|NBO&checkIn=&checkOut=
         Returns { beds: [{ bedId, roomId, roomName, roomType }] } with one
         entry per free bed (for private rooms, one entry per free room).
     - pricing      : GET  {API_BASE}/api/pricing?propertyCode=ADD|NBO
         Room rates from the CMS (dynamic). When the CMS has no rates (or is
         unreachable), prices fall back to data/room-rates.json — the same
         file the server charges from. Private rooms are priced by occupancy:
         1 guest = single rate, 2 guests = double rate.
     - booking      : POST {API_BASE}/api/bookings
         Body: { propertyCode, roomType: "dorm"|"private", checkIn,
                 checkOut, guest: { fullName, guestEmail, phone } }.
         One call books ONE bed/room — the first free one of that type — so
         a stay with multiple units is booked with one POST per unit.
         201 = created, 409 = just sold out, 400 = bad input.
   Online payment: the "prepay" option redirects to Stripe Checkout via
   /.netlify/functions/create-checkout-session (amount computed server-side,
   10% prepay discount); after payment the stripe-webhook function sends the
   confirmation emails. Prepaid bookings are not created in the PMS yet —
   staff enter them manually from the hostel notification email.
   Reserve flow: after a successful PMS booking the confirmation emails
   (hostel + guest) are sent via /.netlify/functions/send-confirmation —
   best-effort, a mail failure never blocks the confirmation page.
   PMS outage tolerance: if the availability check fails (API down), the
   booking is submitted anyway; if the booking POST itself fails, the
   reservation falls back to /.netlify/functions/submit-reservation (email)
   so no booking is lost — staff confirm availability manually. When the
   check succeeds, unavailable/at-capacity dates are blocked as usual.
   Exposes window.MadVervetBooking so later work (e.g. promo codes) can
   extend pricing without rewriting this file.
   Promo extension point (used by js/discount.js): setPricingHook() registers
   { adjust(state), promoLines(state) }. adjust() runs at the END of
   recalculateTotal() (after the base totals above) and may adjust
   state.amountChargedNow / amountDueAtCheckIn; promoLines() injects extra
   summary lines after "Subtotal". Promo fields on state are promoCode,
   promoDiscount and promoDiscountApplied (also sent by buildPayload()). */
(function () {
  "use strict";

  var ROOMS = null; // loaded from data/rooms.json: { locationKey: { name, rooms: [...] } }
  var LOCATION_NAMES = { "addis-ababa": "Addis Ababa", nairobi: "Nairobi" };
  var API_BASE = "https://pms.madvervet.com"; // live booking API (availability + bookings)
  var PROPERTY_CODES = { "addis-ababa": "ADD", nairobi: "NBO" };
  var AMENITY_PRICES = { airportPickup: 15, breakfastPerDayPerGuest: 5, laundry: 10 };
  var PREPAY_RATE = 0.9;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var OFFLINE_MSG = "Couldn't reach the booking system right now — please try again in a moment.";
  /* Fallback nightly rates and amenity prices, fetched from
     data/room-rates.json at startup (used ONLY when the CMS pricing API has
     no rate for a room — CMS pricing always wins when present, see
     resolveRate()). This is the same file the Netlify functions use to
     recompute prices server-side, so the displayed fallback price is the
     price charged. Defaults below apply only until the fetch completes. */
  var FALLBACK_RATES = null;

  var state = {
    location: "addis-ababa",
    roomId: "",
    roomType: "",
    category: "",
    unitLabel: "bed",
    maxUnits: 1,
    units: 1,
    availableUnits: null, // free beds/rooms of the selected category for the chosen dates (null = not fetched)
    rate: null, // nightly rate from CMS pricing (null = not loaded / not set in CMS)
    checkIn: "",
    checkOut: "",
    guests: 1,
    nights: 0,
    amenities: { airportPickup: false, breakfast: false, laundry: false },
    paymentOption: "reserve",
    onlinePaymentEnabled: true, // prepay redirects to Stripe Checkout; confirmation emails come from the stripe-webhook function
    subtotal: 0,
    promoCode: null,
    promoDiscount: 0,
    promoDiscountApplied: false,
    prepayDiscountApplied: false,
    amountChargedNow: 0,
    amountDueAtCheckIn: 0
  };

  var pricingHook = null; // promo/discount hook, registered via setPricingHook()

  function $(id) { return document.getElementById(id); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return "$" + round2(n).toFixed(2); }
  function plural(label, n) { return n === 1 ? label : label + "s"; }

  /* Live availability from the booking API. Free inventory is counted per
     category: "dorm" entries are individual beds, "private" entries are
     whole rooms (one entry per free room). */
  function fetchAvailability(location, checkIn, checkOut) {
    var url = API_BASE + "/api/availability?propertyCode=" + encodeURIComponent(PROPERTY_CODES[location] || "") +
      "&checkIn=" + encodeURIComponent(checkIn) + "&checkOut=" + encodeURIComponent(checkOut);
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error("Availability request failed (" + res.status + ")");
      return res.json();
    });
  }

  function roomById(roomId) {
    var found = null;
    currentRooms().forEach(function (room) { if (room.id === roomId) found = room; });
    return found;
  }

  function checkAvailability(location, roomId, units, checkIn, checkOut) {
    var room = roomById(roomId);
    var category = room ? room.category : "dorm";
    var cmsCategory = room && room.cmsCategory ? room.cmsCategory.toLowerCase() : null;
    var cmsRooms = room && room.cmsRooms && room.cmsRooms.length ? room.cmsRooms : null;
    return fetchAvailability(location, checkIn, checkOut).then(function (data) {
      var remaining = (data.beds || []).filter(function (bed) {
        // Prefer matching by physical room name (cmsRooms) — required when two
        // website rooms share one PMS category (e.g. Nairobi's two 4-bed mixed
        // dorms at different prices). Fall back to the CMS category name, then
        // the coarse roomType when the API omits per-bed category info.
        if (cmsRooms) return cmsRooms.indexOf(bed.roomName) !== -1;
        var bedCat = bed.category && bed.category.name ? bed.category.name.toLowerCase() : null;
        return bedCat && cmsCategory ? bedCat === cmsCategory : bed.roomType === category;
      }).length;
      return { available: remaining >= units, remaining: remaining };
    });
  }

  /* Room pricing from the CMS, fetched once per location. Rates are dynamic —
     when the endpoint is missing or the CMS has no rates yet we show
     "Price on request" instead of a hardcoded number. */
  var PRICING = {}; // locationKey -> { loaded: true, byRoom: { roomName: { bed?, single?, double? } } } or { error: true }

  function fetchPricing(location) {
    var code = PROPERTY_CODES[location];
    if (!code) return Promise.resolve();
    if (PRICING[location]) return Promise.resolve(PRICING[location]);
    return fetch(API_BASE + "/api/pricing?propertyCode=" + encodeURIComponent(code))
      .then(function (res) {
        if (!res.ok) throw new Error("Pricing request failed (" + res.status + ")");
        return res.json();
      })
      .then(function (data) {
        PRICING[location] = { loaded: true, byRoom: normalizePricing(data) };
        return PRICING[location];
      })
      .catch(function () {
        PRICING[location] = { error: true };
        return PRICING[location];
      });
  }

  /* Normalizes the CMS pricing response into byRoom entries:
     dorms → { bed: number }, private rooms → { single: number, double: number }.
     Tolerates { rooms: [...] }, { rates: [...] } and a bare array; entry names
     come from roomName/name, rates from bedRate/dormRate, singleRate/single and
     doubleRate/double. Adjust here if the pricing endpoint shape differs. */
  function normalizePricing(data) {
    var byRoom = {};
    var list = Array.isArray(data) ? data : (data.rooms || data.rates || []);
    list.forEach(function (item) {
      if (!item) return;
      var name = item.roomName || item.name;
      if (!name) return;
      var entry = {};
      var bed = num(item.bedRate != null ? item.bedRate : item.dormRate);
      var single = num(item.singleRate != null ? item.singleRate : item.single);
      var dbl = num(item.doubleRate != null ? item.doubleRate : item.double);
      if (bed != null) entry.bed = bed;
      if (single != null) entry.single = single;
      if (dbl != null) entry.double = dbl;
      byRoom[name] = entry;
    });
    return byRoom;
  }

  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : null; }

  /* Nightly rate for the selected room. CMS pricing wins when present;
     otherwise FALLBACK_RATES. Private rooms are priced by occupancy:
     1 guest = single rate, 2 guests = double rate. Returns null when no
     rate exists at all. */
  function resolveRate() {
    var room = roomById(state.roomId);
    if (!room) return null;
    var entry = null;
    var pricing = PRICING[state.location];
    if (pricing && pricing.loaded) {
      (room.cmsRooms || []).forEach(function (name) {
        if (!entry && pricing.byRoom[name]) entry = pricing.byRoom[name];
      });
    }
    if (!entry) entry = ((FALLBACK_RATES && FALLBACK_RATES[state.location]) || {})[room.id] || null;
    if (!entry) return null;
    if (room.category === "private") {
      var double = room.occupancyPriced && state.guests >= 2;
      return double ? (entry.double != null ? entry.double : entry.single) : entry.single;
    }
    return entry.bed != null ? entry.bed : entry.single;
  }

  /* Keeps the quantity selector in sync with live availability for the
     selected room and dates. Without dates it falls back to the room's
     maxUnits. Debounced — date inputs fire on every keystroke. */
  var availabilityTimer = null;

  function scheduleAvailabilityRefresh() {
    clearTimeout(availabilityTimer);
    availabilityTimer = setTimeout(refreshAvailability, 400);
  }

  function refreshAvailability() {
    var note = $("bk-availability-note");
    if (!state.roomId || !state.checkIn || !state.checkOut || computeNights() <= 0) {
      state.availableUnits = null;
      if (note) note.textContent = state.roomId ? "Choose your dates to see live availability." : "";
      return Promise.resolve(null);
    }
    if (note) note.textContent = "Checking availability…";
    return checkAvailability(state.location, state.roomId, 1, state.checkIn, state.checkOut)
      .then(function (result) {
        state.availableUnits = result.remaining;
        if (note) {
          note.textContent = result.remaining > 0
            ? result.remaining + " " + plural(state.unitLabel, result.remaining) + " available for your dates."
            : "Sold out for your dates — try different dates.";
        }
        renderGuestsOptions();
        return result;
      })
      .catch(function () {
        state.availableUnits = null;
        if (note) note.textContent = "Couldn't load live availability — you can still book, and we'll confirm by email.";
        renderGuestsOptions();
        return null;
      });
  }

  function computeNights() {
    if (!state.checkIn || !state.checkOut) return 0;
    var ms = new Date(state.checkOut) - new Date(state.checkIn);
    return ms > 0 ? Math.round(ms / 86400000) : 0;
  }

  /* Amenity prices for the current location: data/room-rates.json may override
     individual prices per location (amenitiesByLocation) — e.g. breakfast is
     $3/day in Addis Ababa and $5/day in Nairobi. */
  function amenityPrices() {
    var merged = {};
    for (var k in AMENITY_PRICES) merged[k] = AMENITY_PRICES[k];
    var loc = FALLBACK_RATES && FALLBACK_RATES.amenitiesByLocation &&
      FALLBACK_RATES.amenitiesByLocation[state.location];
    if (loc) for (var k2 in loc) merged[k2] = loc[k2];
    return merged;
  }

  function renderAmenityLabels() {
    var el = $("bk-am-breakfast-price");
    if (el) el.textContent = "$" + amenityPrices().breakfastPerDayPerGuest;
  }

  /* Dorms: every guest needs a bed (units = guests, priced per bed per
     guest). Private rooms: one room per booking, priced by occupancy. */
  function recalculateTotal() {
    var prices = amenityPrices();
    state.nights = computeNights();
    state.units = state.category === "private" ? 1 : state.guests;
    state.rate = resolveRate();
    var total = state.rate == null ? 0 : state.nights * state.rate * state.units;
    if (state.amenities.airportPickup) total += prices.airportPickup;
    if (state.amenities.breakfast) total += prices.breakfastPerDayPerGuest * state.nights * state.guests;
    if (state.amenities.laundry) total += prices.laundry;
    state.subtotal = round2(total);
    state.prepayDiscountApplied = state.onlinePaymentEnabled && state.paymentOption === "prepay";
    state.amountChargedNow = state.prepayDiscountApplied ? round2(state.subtotal * PREPAY_RATE) : 0;
    state.amountDueAtCheckIn = state.prepayDiscountApplied ? 0 : state.subtotal;
    if (pricingHook) pricingHook.adjust(state);
    renderSummary();
    return state;
  }

  function renderSummary() {
    var dl = $("booking-summary-lines");
    if (!dl) return;
    var priced = state.rate != null;
    var lines = [];
    if (state.roomType && state.nights > 0) {
      lines.push(["Room", state.roomType + " × " + state.units + " " + plural(state.unitLabel, state.units) +
        " × " + state.nights + " night(s)" + (priced ? " × " + money(state.rate) : "")]);
    }
    lines.push(["Subtotal", priced ? money(state.subtotal) : "TBC — rate confirmed at check-in"]);
    if (pricingHook) pricingHook.promoLines(state).forEach(function (l) { lines.push(l); });
    if (state.paymentOption === "prepay" && state.onlinePaymentEnabled) {
      var discLabel = state.promoDiscountApplied ? "Promo " + state.promoCode : "10% discount";
      lines.push([discLabel, "−" + money(state.subtotal - state.amountChargedNow)]);
      lines.push(["Total due now", money(state.amountChargedNow)]);
      lines.push(["Due at check-in", money(0)]);
    } else {
      lines.push(["Due now", money(0)]);
      lines.push(["Due at check-in", priced ? money(state.amountDueAtCheckIn) : "TBC"]);
    }
    dl.innerHTML = lines.map(function (l) {
      return "<div class=\"summary-line\"><dt>" + l[0] + "</dt><dd>" + l[1] + "</dd></div>";
    }).join("");
  }

  function currentRooms() {
    return (ROOMS && ROOMS[state.location]) ? ROOMS[state.location].rooms : [];
  }

  function renderRooms() {
    var grid = $("room-grid");
    grid.innerHTML = "";
    currentRooms().forEach(function (room) {
      var card = document.createElement("article");
      card.className = "card room-card card--bg" + (state.roomId === room.id ? " room-card--selected" : "");
      if (room.images && room.images.length) {
        card.style.backgroundImage = "url('" + room.images[0].src + "')";
      }
      card.innerHTML =
        "<h3>" + room.type + "</h3>" +
        "<p><span class=\"tag tag--terra\">" + room.note + "</span></p>" +
        "<p><strong>" + priceLabelFor(room) + "</strong></p>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = "Select Room";
      btn.addEventListener("click", function () { selectRoom(room); });
      card.appendChild(btn);
      grid.appendChild(card);
    });
  }

  /* Dynamic price text for a room card — CMS pricing wins, FALLBACK_RATES
     otherwise. Private rooms show the single/double occupancy rates. */
  function priceLabelFor(room) {
    var entry = null;
    var pricing = PRICING[state.location];
    if (pricing && pricing.loaded) {
      (room.cmsRooms || []).forEach(function (name) {
        if (!entry && pricing.byRoom[name]) entry = pricing.byRoom[name];
      });
    }
    if (!entry) entry = ((FALLBACK_RATES && FALLBACK_RATES[state.location]) || {})[room.id] || null;
    if (!entry) return pricing && pricing.error ? "Price on request" : "Loading price…";
    if (room.occupancyPriced && entry.single != null && entry.double != null) {
      return "from " + money(entry.single) + "/night (1 guest) · " + money(entry.double) + "/night (2 guests)";
    }
    var rate = room.category === "private" ? entry.single : (entry.bed != null ? entry.bed : entry.single);
    return rate != null ? money(rate) + "/night per " + room.unitLabel : "Price on request";
  }

  /* Guests are the quantity driver: for dorms each guest needs a bed (cap at
     the dorm's bed count), for private rooms guests are the occupancy that
     drives pricing (Single Room 1, Private Room max 2). */
  function renderGuestsOptions() {
    var select = $("bk-guests");
    var room = roomById(state.roomId);
    var cap = !room ? 4
      : room.category === "private" ? (room.maxOccupancy || 2)
      : room.maxUnits;
    if (state.availableUnits != null) cap = Math.max(1, Math.min(cap, state.availableUnits));
    select.innerHTML = "";
    for (var i = 1; i <= cap; i++) {
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i + (i === 1 ? " guest" : " guests");
      select.appendChild(opt);
    }
    if (state.guests > cap) state.guests = cap;
    select.value = state.guests;
  }

  function renderRoomMedia(room) {
    var media = $("booking-media");
    media.innerHTML = "";
    if (!room.images || !room.images.length) return;
    var gallery = document.createElement("div");
    gallery.className = "gallery";
    var main = document.createElement("img");
    main.className = "gallery-main";
    main.src = room.images[0].src;
    main.alt = room.images[0].alt;
    gallery.appendChild(main);
    var thumbs = document.createElement("div");
    thumbs.className = "gallery-thumbs";
    room.images.forEach(function (img, i) {
      var thumb = document.createElement("img");
      thumb.className = "gallery-thumb" + (i === 0 ? " gallery-thumb--active" : "");
      thumb.src = img.src;
      thumb.alt = img.alt;
      thumb.tabIndex = 0;
      thumb.setAttribute("role", "button");
      thumb.setAttribute("aria-label", "View photo: " + img.alt);
      thumb.loading = "lazy";
      thumbs.appendChild(thumb);
    });
    gallery.appendChild(thumbs);
    media.appendChild(gallery);
    if (typeof window.initGalleries === "function") window.initGalleries(media);
  }

  function selectRoom(room) {
    state.roomId = room.id;
    state.roomType = room.type;
    state.category = room.category;
    state.unitLabel = room.unitLabel;
    state.maxUnits = room.maxUnits;
    state.availableUnits = null;
    state.rate = null;
    state.guests = room.category === "private" && room.occupancyPriced ? 2 : 1;
    $("bk-room").value = room.type + " — " + LOCATION_NAMES[state.location];
    renderGuestsOptions();
    refreshAvailability();
    renderRoomMedia(room);
    $("booking-detail").hidden = false;
    $("booking-hint").hidden = true;
    renderRooms();
    recalculateTotal();
    $("booking-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function selectLocation(loc) {
    state.location = loc;
    state.roomId = "";
    state.roomType = "";
    state.rate = null;
    state.availableUnits = null;
    document.querySelectorAll(".location-tab").forEach(function (tab) {
      var active = tab.dataset.location === loc;
      tab.classList.toggle("location-tab--active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("booking-detail").hidden = true;
    $("booking-hint").hidden = false;
    renderRooms();
    renderAmenityLabels();
    recalculateTotal();
    fetchPricing(loc).then(function () {
      renderRooms();
      recalculateTotal();
    });
  }

  function showError(input, msg) {
    clearError(input);
    var err = document.createElement("p");
    err.className = "field-error";
    err.textContent = msg;
    err.id = input.id + "-error";
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", err.id);
    input.parentNode.appendChild(err);
  }

  function clearError(input) {
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    var err = input.parentNode.querySelector(".field-error");
    if (err) err.remove();
  }

  function validate() {
    var valid = true;
    [["bk-name"], ["bk-email"], ["bk-phone"], ["bk-checkin"], ["bk-checkout"]].forEach(function (pair) {
      var input = $(pair[0]);
      clearError(input);
      var val = input.value.trim();
      if (!val) {
        showError(input, "This field is required.");
        valid = false;
      } else if (input.type === "email" && !EMAIL_RE.test(val)) {
        showError(input, "Please enter a valid email address.");
        valid = false;
      }
    });
    if (state.checkIn && state.checkOut && computeNights() <= 0) {
      showError($("bk-checkout"), "Check-out must be after check-in.");
      valid = false;
    }
    if (!state.roomType) valid = false;
    return valid;
  }

  function buildPayload() {
    return {
      location: state.location,
      roomId: state.roomId,
      roomType: state.roomType,
      units: state.units,
      unitLabel: state.unitLabel,
      checkIn: state.checkIn,
      checkOut: state.checkOut,
      guests: state.guests,
      amenities: {
        airportPickup: state.amenities.airportPickup,
        breakfast: state.amenities.breakfast,
        laundry: state.amenities.laundry
      },
      guest: {
        name: $("bk-name").value.trim(),
        email: $("bk-email").value.trim(),
        phone: $("bk-phone").value.trim()
      },
      specialRequests: $("bk-requests").value.trim(),
      subtotal: state.subtotal,
      paymentOption: state.paymentOption,
      prepayDiscountApplied: state.prepayDiscountApplied,
      promoCode: state.promoCode || null,
      promoDiscountApplied: !!state.promoDiscountApplied,
      amountChargedNow: state.amountChargedNow,
      amountDueAtCheckIn: state.amountDueAtCheckIn
    };
  }

  function setStatus(msg, isOk) {
    var form = $("booking-form");
    var status = form.querySelector(".form-status");
    if (!status) {
      status = document.createElement("div");
      status.setAttribute("role", "status");
      form.appendChild(status);
    }
    status.className = "form-status " + (isOk ? "form-status--ok" : "form-status--error");
    status.textContent = msg;
  }

  /* Assigns each unit to a physical room (by PMS room name, from the room's
     cmsRooms) using live availability, so the booking targets the right room
     — required when one PMS category spans multiple price points (Nairobi's
     two mixed dorms) and for Single Rooms (PMS category "single"). Returns an
     array of room names (one per unit), or null when availability can't be
     fetched — the POST then falls back to coarse roomType booking. */
  function planRoomAssignments() {
    var room = roomById(state.roomId);
    var names = room && room.cmsRooms && room.cmsRooms.length ? room.cmsRooms : null;
    if (!names) return Promise.resolve(null);
    return fetchAvailability(state.location, state.checkIn, state.checkOut).then(function (data) {
      var free = {};
      (data.beds || []).forEach(function (b) {
        if (names.indexOf(b.roomName) !== -1) free[b.roomName] = (free[b.roomName] || 0) + 1;
      });
      var assignments = [];
      for (var i = 0; i < state.units; i++) {
        var target = null;
        names.forEach(function (n) { if (!target && (free[n] || 0) > 0) target = n; });
        if (!target) return null; // fewer free units than expected — let it 409 naturally
        free[target]--;
        assignments.push(target);
      }
      return assignments;
    }).catch(function () { return null; });
  }

  /* The API books exactly one bed/room per call, so a multi-unit stay is
     booked with one sequential POST per unit. Resolves with the booking IDs;
     a 409 mid-way rejects with err.soldOut = true (earlier units are
     already booked at that point). */
  function createBookings() {
    return planRoomAssignments().then(function (assignments) {
      var ids = [];
      var chain = Promise.resolve();
      for (var i = 0; i < state.units; i++) {
        (function (roomCategory) {
          chain = chain.then(function () {
            // The PMS requires exactly one of roomCategory / roomType.
            var payload = {
              propertyCode: PROPERTY_CODES[state.location],
              checkIn: state.checkIn,
              checkOut: state.checkOut,
              guest: {
                fullName: $("bk-name").value.trim(),
                guestEmail: $("bk-email").value.trim(),
                phone: $("bk-phone").value.trim()
              }
            };
            if (roomCategory) payload.roomCategory = roomCategory;
            else payload.roomType = state.category;
            return fetch(API_BASE + "/api/bookings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
          }).then(function (res) {
            if (res.status === 409) {
              var err = new Error("sold out");
              err.soldOut = true;
              err.bookedCount = ids.length;
              throw err;
            }
            if (!res.ok) throw new Error("Booking failed (" + res.status + ")");
            return res.json();
          }).then(function (body) {
            ids.push(body.bookingId);
          });
        })(assignments ? assignments[i] : null);
      }
      return chain.then(function () { return ids; }, function (err) {
        if (err && err.bookedCount == null) err.bookedCount = ids.length;
        throw err;
      });
    });
  }

  /* Fallback when the PMS is unreachable: capture the reservation by email
     via the submit-reservation Netlify function so no booking is lost. Staff
     confirm availability manually and follow up with the guest. */
  function submitReservationFallback(bookedCount) {
    var payload = buildPayload();
    payload.paymentOption = "reserve"; // the email path is reserve-only
    payload.specialRequests = (payload.specialRequests ? payload.specialRequests + " " : "") +
      "[Booking system unreachable — reservation captured by email fallback; please confirm availability manually." +
      (bookedCount ? " Note: " + bookedCount + " " + plural(payload.unitLabel, bookedCount) +
        " may already be booked in the PMS before the connection failed." : "") + "]";
    return fetch("/.netlify/functions/submit-reservation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function (res) {
      if (!res.ok) throw new Error("Fallback reservation failed (" + res.status + ")");
      return res.json();
    }).then(function (body) {
      if (body.redirectUrl) {
        window.location.href = body.redirectUrl;
      } else {
        setStatus("Thanks! Your reservation request has been received — we'll confirm by email.", true);
      }
    });
  }

  /* After the PMS confirms a booking, send the hostel notification + guest
     confirmation emails via the send-confirmation function. Best-effort: a
     failure here must not block the redirect to the confirmation page. */
  function sendConfirmationEmails(ids) {
    var payload = buildPayload();
    payload.refs = ids;
    return fetch("/.netlify/functions/send-confirmation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(function () { /* email is best-effort — the booking already exists */ });
  }

  /* Prepay path: hand the guest to Stripe Checkout. The charged amount is
     computed server-side (subtotal − max(10% prepay discount, promo)); the
     stripe-webhook function sends the confirmation emails after payment.
     No PMS booking is created here — staff enter prepaid bookings manually
     from the hostel notification email while the PMS is down. */
  function startStripeCheckout() {
    setStatus("Redirecting to secure payment…", true);
    fetch("/.netlify/functions/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload())
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok || !body.checkoutUrl) {
          throw new Error(body.error || "Payment session failed (" + res.status + ")");
        }
        window.location.href = body.checkoutUrl;
      });
    }).catch(function (err) {
      setStatus("Couldn't start online payment (" + err.message + "). " +
        "Please try again, or choose \"Reserve now, pay at the property\".", false);
    });
  }

  function submitBooking() {
    createBookings()
      .then(function (ids) {
        var ref = ids.join(", ");
        setStatus("Thanks! Your reservation has been received — pay at the property.", true);
        sendConfirmationEmails(ids).finally(function () {
          window.location.href = "booking-confirmation.html?type=reserve&ref=" + encodeURIComponent(ref) +
            "&location=" + encodeURIComponent(state.location);
        });
      })
      .catch(function (err) {
        if (err && err.soldOut) {
          setStatus("Someone just booked the last of these " + plural(state.unitLabel, 2) +
            " — fewer may still be available. Check the availability note and try again." +
            (err.bookedCount ? " Heads-up: " + err.bookedCount + " of your " + plural(state.unitLabel, 2) +
              " may already be booked — contact us before retrying." : ""), false);
          refreshAvailability();
        } else {
          setStatus("The booking system is unreachable — sending your reservation by email instead…", true);
          submitReservationFallback(err && err.bookedCount).catch(function () {
            setStatus(OFFLINE_MSG, false);
          });
        }
      });
  }

  function proceedWithBooking() {
    if (state.paymentOption === "prepay" && state.onlinePaymentEnabled) {
      startStripeCheckout();
    } else {
      submitBooking();
    }
  }

  function confirmBooking() {
    var submitBtn = $("bk-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Checking availability…";
    setStatus("Checking availability for your dates…", true);
    checkAvailability(state.location, state.roomId, state.units, state.checkIn, state.checkOut)
      .then(function (result) {
        if (!result.available) {
          setStatus("Sorry — those " + plural(state.unitLabel, state.units) +
            " aren't available for your dates. Try fewer " + plural(state.unitLabel, 2) +
            " or different dates.", false);
          return;
        }
        proceedWithBooking();
      })
      .catch(function () {
        setStatus("Couldn't check availability right now — submitting your booking anyway. We'll confirm by email.", true);
        proceedWithBooking();
      })
      .finally(function () {
        submitBtn.disabled = false;
        syncFromInputs();
      });
  }

  /* Past dates are disabled in the date pickers via the min attribute
     (local timezone). Check-out's minimum tracks the day after check-in. */
  function dateISO(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function initDateBounds() {
    var today = new Date();
    $("bk-checkin").min = dateISO(today);
    $("bk-checkout").min = dateISO(new Date(today.getTime() + 86400000));
  }

  function syncDateBounds() {
    var checkin = $("bk-checkin").value;
    if (checkin) {
      $("bk-checkout").min = dateISO(new Date(new Date(checkin).getTime() + 86400000));
    }
  }

  function syncFromInputs() {
    var datesChanged = state.checkIn !== $("bk-checkin").value || state.checkOut !== $("bk-checkout").value;
    state.checkIn = $("bk-checkin").value;
    state.checkOut = $("bk-checkout").value;
    if (datesChanged) scheduleAvailabilityRefresh();
    syncDateBounds();
    state.guests = Number($("bk-guests").value) || 1;
    state.amenities.airportPickup = $("bk-am-airport").checked;
    state.amenities.breakfast = $("bk-am-breakfast").checked;
    state.amenities.laundry = $("bk-am-laundry").checked;
    var pay = document.querySelector('input[name="paymentOption"]:checked');
    state.paymentOption = pay ? pay.value : "reserve";
    $("bk-submit").textContent =
      state.paymentOption === "prepay" && state.onlinePaymentEnabled ? "Pay Now — Save 10%" : "Submit Reservation";
    recalculateTotal();
  }

  function initFromUrl() {
    var loc = new URLSearchParams(window.location.search).get("location");
    selectLocation(ROOMS[loc] ? loc : "addis-ababa");
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Fallback rates + amenity prices (same file the server charges from).
    // Best-effort: defaults apply until this resolves.
    fetch("data/room-rates.json")
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (rates) {
        if (!rates) return;
        FALLBACK_RATES = rates;
        AMENITY_PRICES = rates.amenities || AMENITY_PRICES;
        renderAmenityLabels();
        if (ROOMS) {
          renderRooms();
          recalculateTotal();
        }
      })
      .catch(function () { /* keep defaults */ });
    fetch("data/rooms.json")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load rooms");
        return res.json();
      })
      .then(function (data) {
        ROOMS = data;
        initDateBounds();
        document.querySelectorAll(".location-tab").forEach(function (tab) {
          tab.addEventListener("click", function () { selectLocation(tab.dataset.location); });
        });
        $("booking-form").addEventListener("input", syncFromInputs);
        $("booking-form").addEventListener("change", syncFromInputs);
        $("booking-form").addEventListener("submit", function (e) {
          e.preventDefault();
          syncFromInputs();
          if (!validate()) return;
          confirmBooking();
        });
        initFromUrl();
      })
      .catch(function () {
        $("room-grid").innerHTML =
          "<p class=\"placeholder-note\">Rooms couldn't be loaded right now — please refresh the page or try again later.</p>";
      });
  });

  window.MadVervetBooking = {
    state: state,
    rooms: function () { return ROOMS; },
    recalculateTotal: recalculateTotal,
    buildPayload: buildPayload,
    selectLocation: selectLocation,
    selectRoom: selectRoom,
    checkAvailability: checkAvailability,
    setPricingHook: function (hook) { pricingHook = hook; }
  };
})();
