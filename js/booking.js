/* booking.js — room selection, live pricing and submission for book.html.
   Room data is loaded from data/rooms.json (later to be served by the CMS).
   Availability and bookings come from the live booking API (see API_BASE):
     - availability : GET  {API_BASE}/api/availability?propertyCode=ADD|NBO&checkIn=&checkOut=
         Returns { beds: [{ bedId, roomId, roomName, roomType }] } with one
         entry per free bed (for private rooms, one entry per free room).
     - pricing      : GET  {API_BASE}/api/pricing?propertyCode=ADD|NBO
         Room rates from the CMS (dynamic — no prices are hardcoded; if the
         CMS has no rates yet we show "Price on request"). Private rooms are
         priced by occupancy: 1 guest = single rate, 2 guests = double rate.
     - booking      : POST {API_BASE}/api/bookings
         Body: { propertyCode, roomType: "dorm"|"private", checkIn,
                 checkOut, guest: { fullName, guestEmail, phone } }.
         One call books ONE bed/room — the first free one of that type — so
         a stay with multiple units is booked with one POST per unit.
         201 = created, 409 = just sold out, 400 = bad input.
   Online payment is not connected yet: both payment options create the
   reservation through the API and the guest pays at the property.
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
  var API_BASE = "http://localhost:3001"; // local booking API — swap for the live URL when deployed
  var PROPERTY_CODES = { "addis-ababa": "ADD", nairobi: "NBO" };
  var AMENITY_PRICES = { airportPickup: 15, breakfastPerDayPerGuest: 5, laundry: 10 };
  var PREPAY_RATE = 0.9;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var OFFLINE_MSG = "Couldn't reach the booking system right now — please try again in a moment.";

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
    guests: 2,
    nights: 0,
    amenities: { airportPickup: false, breakfast: false, laundry: false },
    paymentOption: "reserve",
    onlinePaymentEnabled: false, // no online charge until the payment step is wired up — prepay prices as reserve
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
    var names = room && room.cmsRooms ? room.cmsRooms : [];
    return fetchAvailability(location, checkIn, checkOut).then(function (data) {
      var remaining = (data.beds || []).filter(function (bed) {
        return names.length ? names.indexOf(bed.roomName) !== -1 : bed.roomType === category;
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

  /* Nightly rate for the selected room from CMS pricing. Private rooms are
     priced by occupancy: 1 guest = single rate, 2 guests = double rate.
     Returns null when pricing hasn't loaded or isn't set for the room. */
  function resolveRate() {
    var room = roomById(state.roomId);
    if (!room) return null;
    var pricing = PRICING[state.location];
    if (!pricing || !pricing.loaded) return null;
    var entry = null;
    (room.cmsRooms || []).forEach(function (name) {
      if (!entry && pricing.byRoom[name]) entry = pricing.byRoom[name];
    });
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
      renderQuantityOptions();
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
        renderQuantityOptions();
        return result;
      })
      .catch(function () {
        state.availableUnits = null;
        if (note) note.textContent = "Couldn't load live availability — showing maximum capacity.";
        renderQuantityOptions();
        return null;
      });
  }

  function computeNights() {
    if (!state.checkIn || !state.checkOut) return 0;
    var ms = new Date(state.checkOut) - new Date(state.checkIn);
    return ms > 0 ? Math.round(ms / 86400000) : 0;
  }

  function recalculateTotal() {
    state.nights = computeNights();
    state.rate = resolveRate();
    var total = state.rate == null ? 0 : state.nights * state.rate * state.units;
    if (state.amenities.airportPickup) total += AMENITY_PRICES.airportPickup;
    if (state.amenities.breakfast) total += AMENITY_PRICES.breakfastPerDayPerGuest * state.nights * state.guests;
    if (state.amenities.laundry) total += AMENITY_PRICES.laundry;
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

  /* Dynamic price text for a room card — from CMS pricing, never hardcoded.
     Private rooms show the single/double occupancy rates when known. */
  function priceLabelFor(room) {
    var pricing = PRICING[state.location];
    if (!pricing) return "Loading price…";
    if (pricing.error || !pricing.loaded) return "Price on request";
    var entry = null;
    (room.cmsRooms || []).forEach(function (name) {
      if (!entry && pricing.byRoom[name]) entry = pricing.byRoom[name];
    });
    if (!entry) return "Price on request";
    if (room.occupancyPriced && entry.single != null && entry.double != null) {
      return "from " + money(entry.single) + "/night (1 guest) · " + money(entry.double) + "/night (2 guests)";
    }
    var rate = room.category === "private" ? entry.single : (entry.bed != null ? entry.bed : entry.single);
    return rate != null ? money(rate) + "/night per " + room.unitLabel : "Price on request";
  }

  /* Occupancy drives private-room pricing: cap the guests selector at the
     room's maxOccupancy (dorms keep 1–4 guests). */
  function renderGuestsOptions() {
    var select = $("bk-guests");
    var room = roomById(state.roomId);
    var cap = room && room.category === "private" ? (room.maxOccupancy || 2) : 4;
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

  function renderQuantityOptions() {
    var select = $("bk-quantity");
    $("bk-quantity-label").textContent = "Number of " + plural(state.unitLabel, 2);
    select.innerHTML = "";
    var cap = state.availableUnits == null
      ? state.maxUnits
      : Math.min(state.maxUnits, Math.max(state.availableUnits, 1));
    for (var i = 1; i <= cap; i++) {
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i + " " + plural(state.unitLabel, i);
      select.appendChild(opt);
    }
    if (state.availableUnits === 0) {
      var soldOut = document.createElement("option");
      soldOut.value = "";
      soldOut.textContent = "Sold out for these dates";
      soldOut.disabled = true;
      select.appendChild(soldOut);
      select.value = "";
    } else {
      if (state.units > cap) state.units = cap;
      select.value = state.units;
    }
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
    state.units = 1;
    state.availableUnits = null;
    state.rate = null;
    $("bk-room").value = room.type + " — " + LOCATION_NAMES[state.location];
    renderQuantityOptions();
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

  /* The API books exactly one bed/room per call, so a multi-unit stay is
     booked with one sequential POST per unit. Resolves with the booking IDs;
     a 409 mid-way rejects with err.soldOut = true (earlier units are
     already booked at that point). */
  function createBookings() {
    var ids = [];
    var chain = Promise.resolve();
    for (var i = 0; i < state.units; i++) {
      chain = chain.then(function () {
        return fetch(API_BASE + "/api/bookings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            propertyCode: PROPERTY_CODES[state.location],
            roomType: state.category,
            checkIn: state.checkIn,
            checkOut: state.checkOut,
            guest: {
              fullName: $("bk-name").value.trim(),
              guestEmail: $("bk-email").value.trim(),
              phone: $("bk-phone").value.trim()
            }
          })
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
      });
    }
    return chain.then(function () { return ids; });
  }

  function submitBooking() {
    createBookings()
      .then(function (ids) {
        var ref = ids.join(", ");
        setStatus("Thanks! Your reservation has been received — pay at the property.", true);
        window.location.href = "booking-confirmation.html?type=reserve&ref=" + encodeURIComponent(ref);
      })
      .catch(function (err) {
        if (err && err.soldOut) {
          setStatus("Someone just booked the last of these " + plural(state.unitLabel, 2) +
            " — fewer may still be available. Check the availability note and try again." +
            (err.bookedCount ? " Heads-up: " + err.bookedCount + " of your " + plural(state.unitLabel, 2) +
              " may already be booked — contact us before retrying." : ""), false);
          refreshAvailability();
        } else {
          setStatus(OFFLINE_MSG, false);
        }
      });
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
        submitBooking();
      })
      .catch(function () {
        setStatus("Couldn't check availability right now — please try again.", false);
      })
      .finally(function () {
        submitBtn.disabled = false;
        syncFromInputs();
      });
  }

  function syncFromInputs() {
    var datesChanged = state.checkIn !== $("bk-checkin").value || state.checkOut !== $("bk-checkout").value;
    state.checkIn = $("bk-checkin").value;
    state.checkOut = $("bk-checkout").value;
    if (datesChanged) scheduleAvailabilityRefresh();
    state.guests = Number($("bk-guests").value) || 1;
    state.units = Math.min(Number($("bk-quantity").value) || 1, state.maxUnits);
    state.amenities.airportPickup = $("bk-am-airport").checked;
    state.amenities.breakfast = $("bk-am-breakfast").checked;
    state.amenities.laundry = $("bk-am-laundry").checked;
    var pay = document.querySelector('input[name="paymentOption"]:checked');
    state.paymentOption = pay ? pay.value : "reserve";
    $("bk-submit").textContent = "Submit Reservation";
    recalculateTotal();
  }

  function initFromUrl() {
    var loc = new URLSearchParams(window.location.search).get("location");
    selectLocation(ROOMS[loc] ? loc : "addis-ababa");
  }

  document.addEventListener("DOMContentLoaded", function () {
    fetch("data/rooms.json")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load rooms");
        return res.json();
      })
      .then(function (data) {
        ROOMS = data;
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
