/* booking.js — room selection, live pricing and submission for book.html.
   Room data is loaded from data/rooms.json (later to be served by the CMS).
   Endpoints (Netlify functions, not yet implemented):
     - reserve : POST /.netlify/functions/submit-reservation
     - prepay  : POST /.netlify/functions/create-checkout-session
   Both accept the JSON payload built by buildPayload(). On any failure or
   non-OK response we show a friendly "not connected yet" message.
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
  var AMENITY_PRICES = { airportPickup: 15, breakfastPerDayPerGuest: 5, laundry: 10 };
  var PREPAY_RATE = 0.9;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var OFFLINE_MSG = "Payment isn't connected yet — this will work once the payment step is deployed.";

  var state = {
    location: "addis-ababa",
    roomId: "",
    roomType: "",
    category: "",
    unitLabel: "bed",
    maxUnits: 1,
    units: 1,
    rate: 0,
    checkIn: "",
    checkOut: "",
    guests: 2,
    nights: 0,
    amenities: { airportPickup: false, breakfast: false, laundry: false },
    paymentOption: "reserve",
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

  /* Availability check — STUB. Before a booking is confirmed this must look
     up live bed/room availability in the CMS (endpoint TBD, e.g.
     POST /.netlify/functions/check-availability with
     { location, roomId, units, checkIn, checkOut }).
     For now it always reports available after a short simulated delay. */
  function checkAvailability(location, roomId, units, checkIn, checkOut) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve({ available: true, remaining: null });
      }, 600);
    });
  }

  function computeNights() {
    if (!state.checkIn || !state.checkOut) return 0;
    var ms = new Date(state.checkOut) - new Date(state.checkIn);
    return ms > 0 ? Math.round(ms / 86400000) : 0;
  }

  function recalculateTotal() {
    state.nights = computeNights();
    var total = state.nights * state.rate * state.units;
    if (state.amenities.airportPickup) total += AMENITY_PRICES.airportPickup;
    if (state.amenities.breakfast) total += AMENITY_PRICES.breakfastPerDayPerGuest * state.nights * state.guests;
    if (state.amenities.laundry) total += AMENITY_PRICES.laundry;
    state.subtotal = round2(total);
    state.prepayDiscountApplied = state.paymentOption === "prepay";
    state.amountChargedNow = state.prepayDiscountApplied ? round2(state.subtotal * PREPAY_RATE) : 0;
    state.amountDueAtCheckIn = state.prepayDiscountApplied ? 0 : state.subtotal;
    if (pricingHook) pricingHook.adjust(state);
    renderSummary();
    return state;
  }

  function renderSummary() {
    var dl = $("booking-summary-lines");
    if (!dl) return;
    var lines = [];
    if (state.roomType && state.nights > 0) {
      lines.push(["Room", state.roomType + " × " + state.units + " " + plural(state.unitLabel, state.units) +
        " × " + state.nights + " night(s) × " + money(state.rate)]);
    }
    lines.push(["Subtotal", money(state.subtotal)]);
    if (pricingHook) pricingHook.promoLines(state).forEach(function (l) { lines.push(l); });
    if (state.paymentOption === "prepay") {
      var discLabel = state.promoDiscountApplied ? "Promo " + state.promoCode : "10% discount";
      lines.push([discLabel, "−" + money(state.subtotal - state.amountChargedNow)]);
      lines.push(["Total due now", money(state.amountChargedNow)]);
      lines.push(["Due at check-in", money(0)]);
    } else {
      lines.push(["Due now", money(0)]);
      lines.push(["Due at check-in", money(state.amountDueAtCheckIn)]);
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
        "<p><strong>" + money(room.rate) + "/night per " + room.unitLabel + "</strong></p>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = "Select Room";
      btn.addEventListener("click", function () { selectRoom(room); });
      card.appendChild(btn);
      grid.appendChild(card);
    });
  }

  function renderQuantityOptions() {
    var select = $("bk-quantity");
    $("bk-quantity-label").textContent = "Number of " + plural(state.unitLabel, 2);
    select.innerHTML = "";
    for (var i = 1; i <= state.maxUnits; i++) {
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = i + " " + plural(state.unitLabel, i);
      select.appendChild(opt);
    }
    select.value = state.units;
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
    state.rate = room.rate;
    $("bk-room").value = room.type + " — " + LOCATION_NAMES[state.location];
    renderQuantityOptions();
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
    state.rate = 0;
    document.querySelectorAll(".location-tab").forEach(function (tab) {
      var active = tab.dataset.location === loc;
      tab.classList.toggle("location-tab--active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("booking-detail").hidden = true;
    $("booking-hint").hidden = false;
    renderRooms();
    recalculateTotal();
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

  function submitBooking() {
    var prepay = state.paymentOption === "prepay";
    var endpoint = prepay
      ? "/.netlify/functions/create-checkout-session"
      : "/.netlify/functions/submit-reservation";
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload())
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed");
        return res.json();
      })
      .then(function (body) {
        var url = prepay ? body.checkoutUrl : body.redirectUrl;
        setStatus(prepay
          ? "Thanks! Redirecting to secure checkout…"
          : "Thanks! Your reservation has been received — pay at check-in.", true);
        if (url) window.location.href = url;
      })
      .catch(function () {
        setStatus(OFFLINE_MSG, false);
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
    state.checkIn = $("bk-checkin").value;
    state.checkOut = $("bk-checkout").value;
    state.guests = Number($("bk-guests").value) || 1;
    state.units = Math.min(Number($("bk-quantity").value) || 1, state.maxUnits);
    state.amenities.airportPickup = $("bk-am-airport").checked;
    state.amenities.breakfast = $("bk-am-breakfast").checked;
    state.amenities.laundry = $("bk-am-laundry").checked;
    var pay = document.querySelector('input[name="paymentOption"]:checked');
    state.paymentOption = pay ? pay.value : "reserve";
    $("bk-submit").textContent = state.paymentOption === "prepay"
      ? "Pay & Reserve — Save 10%"
      : "Submit Reservation";
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
