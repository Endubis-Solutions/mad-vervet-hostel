/* tours.js — country selection, tour cards and purchase flow for tours.html.
   Tour data is loaded from data/tours.json (keyed by country: ethiopia/kenya).
   Purchase paths:
     - reserve : POST /.netlify/functions/tour-inquiry (pay at the desk)
     - paynow  : POST /.netlify/functions/create-checkout-session (Stripe —
                 the payment step is a stub until the backend is connected)
   Discounts: guests arriving from the booking-confirmation upsell carry
   ?discount=guest (5% guest discount); paying online now adds another 5%. */
(function () {
  "use strict";

  var TOURS = null; // loaded from data/tours.json
  var GUEST_RATE = 0.05;  // 5% guest discount (upsell arrivals)
  var PAYNOW_RATE = 0.05; // extra 5% for paying online now
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var OFFLINE_MSG = "Payment isn't connected yet — this will work once the payment step is deployed.";

  var state = {
    location: "ethiopia",
    tourId: "",
    tourName: "",
    price: 0,
    date: "",
    travellers: 2,
    paymentOption: "reserve",
    guestDiscount: false
  };

  function $(id) { return document.getElementById(id); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return "$" + round2(n).toFixed(2); }

  function discountRate() {
    return (state.guestDiscount ? GUEST_RATE : 0) + (state.paymentOption === "paynow" ? PAYNOW_RATE : 0);
  }

  function totals() {
    var base = round2(state.price * state.travellers);
    var discount = round2(base * discountRate());
    return { base: base, discount: discount, total: round2(base - discount) };
  }

  function renderSummary() {
    var dl = $("tour-summary-lines");
    if (!dl) return;
    var t = totals();
    var lines = [];
    if (state.tourName) {
      lines.push(["Tour", state.tourName + " × " + state.travellers + " traveller(s) × " + money(state.price)]);
    }
    lines.push(["Subtotal", money(t.base)]);
    if (state.guestDiscount) lines.push(["Guest discount (5%)", "−" + money(round2(t.base * GUEST_RATE))]);
    if (state.paymentOption === "paynow") lines.push(["Pay-now discount (5%)", "−" + money(round2(t.base * PAYNOW_RATE))]);
    if (state.paymentOption === "paynow") {
      lines.push(["Total due now", money(t.total)]);
    } else {
      lines.push(["Due now", money(0)]);
      lines.push(["Due at the tour desk", money(t.total)]);
    }
    dl.innerHTML = lines.map(function (l) {
      return "<div class=\"summary-line\"><dt>" + l[0] + "</dt><dd>" + l[1] + "</dd></div>";
    }).join("");
  }

  function currentTours() {
    return (TOURS && TOURS[state.location]) ? TOURS[state.location].tours : [];
  }

  function renderTours() {
    var grid = $("tour-grid");
    grid.innerHTML = "";
    currentTours().forEach(function (tour) {
      var card = document.createElement("article");
      card.className = "card card--pink card--bg" + (state.tourId === tour.id ? " room-card--selected" : "");
      if (tour.image) card.style.backgroundImage = "url('" + tour.image + "')";
      card.innerHTML =
        "<h3>" + tour.name + "</h3>" +
        "<p><span class=\"tag\">" + tour.duration + "</span></p>" +
        "<p>" + tour.description + "</p>" +
        "<p><strong>" + money(tour.price) + "/person</strong></p>";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.textContent = "Book This Tour";
      btn.addEventListener("click", function () { selectTour(tour); });
      card.appendChild(btn);
      grid.appendChild(card);
    });
  }

  function selectTour(tour) {
    state.tourId = tour.id;
    state.tourName = tour.name;
    state.price = tour.price;
    $("tp-tour").value = tour.name + " — " + TOURS[state.location].name;
    $("tour-purchase-form").hidden = false;
    $("purchase-hint").hidden = true;
    renderTours();
    renderSummary();
    $("purchase-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function selectLocation(loc) {
    state.location = loc;
    state.tourId = "";
    state.tourName = "";
    state.price = 0;
    document.querySelectorAll(".location-tab").forEach(function (tab) {
      var active = tab.dataset.location === loc;
      tab.classList.toggle("location-tab--active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    $("tour-purchase-form").hidden = true;
    $("purchase-hint").hidden = false;
    renderTours();
    renderSummary();
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
    ["tp-name", "tp-email", "tp-phone", "tp-date", "tp-guests"].forEach(function (id) {
      var input = $(id);
      clearError(input);
      var val = input.value.trim();
      if (!val) {
        showError(input, "This field is required.");
        valid = false;
      } else if (input.type === "email" && !EMAIL_RE.test(val)) {
        showError(input, "Please enter a valid email address.");
        valid = false;
      } else if (input.type === "number" && Number(val) < 1) {
        showError(input, "At least 1 traveller.");
        valid = false;
      }
    });
    if (!state.tourId) valid = false;
    return valid;
  }

  function setStatus(msg, isOk) {
    var form = $("tour-purchase-form");
    var status = form.querySelector(".form-status");
    if (!status) {
      status = document.createElement("div");
      status.setAttribute("role", "status");
      form.appendChild(status);
    }
    status.className = "form-status " + (isOk ? "form-status--ok" : "form-status--error");
    status.textContent = msg;
  }

  function syncFromInputs() {
    state.date = $("tp-date").value;
    state.travellers = Math.max(Number($("tp-guests").value) || 1, 1);
    var pay = document.querySelector('input[name="paymentOption"]:checked');
    state.paymentOption = pay ? pay.value : "reserve";
    $("tp-submit").textContent = state.paymentOption === "paynow"
      ? "Pay Now — Extra 5% Off"
      : "Book Tour";
    renderSummary();
  }

  function submitPurchase() {
    var t = totals();
    if (state.paymentOption === "paynow") {
      /* Pay-now path — STUB payment. Reuses the booking checkout session
         endpoint with a booking-shaped payload (tour as "roomType"). The
         server recomputes the charge; replace with a dedicated tour-checkout
         function when payments are wired up. */
      var payload = {
        location: TOURS[state.location].hostelLocation,
        roomType: "Tour: " + state.tourName,
        checkIn: state.date,
        checkOut: state.date,
        guests: state.travellers,
        subtotal: t.base,
        paymentOption: "prepay",
        guest: {
          name: $("tp-name").value.trim(),
          email: $("tp-email").value.trim(),
          phone: $("tp-phone").value.trim()
        },
        specialRequests: "Tour purchase via tours page. Guest discount: " +
          (state.guestDiscount ? "5%" : "none") + ". Advertised total: " + money(t.total)
      };
      fetch("/.netlify/functions/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Request failed");
          return res.json();
        })
        .then(function (body) {
          setStatus("Thanks! Redirecting to secure checkout…", true);
          if (body.checkoutUrl) window.location.href = body.checkoutUrl;
        })
        .catch(function () {
          setStatus(OFFLINE_MSG, false);
        });
      return;
    }
    fetch("/.netlify/functions/tour-inquiry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: $("tp-name").value.trim(),
        email: $("tp-email").value.trim(),
        phone: $("tp-phone").value.trim(),
        tour: state.tourName + " — " + TOURS[state.location].name,
        guests: state.travellers,
        date: state.date,
        message: "Reserved via tours page. Total due at desk: " + money(t.total) +
          (state.guestDiscount ? " (5% guest discount applied)" : "")
      })
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed");
        setStatus("Thanks! Your tour is reserved — pay at the tour desk. We'll email you the details.", true);
      })
      .catch(function () {
        setStatus(OFFLINE_MSG, false);
      });
  }

  function initFromUrl() {
    var params = new URLSearchParams(window.location.search);
    state.guestDiscount = params.get("discount") === "guest";
    var loc = params.get("location");
    selectLocation(TOURS[loc] ? loc : "ethiopia");
    var tourId = params.get("tour");
    if (tourId) {
      var match = currentTours().filter(function (t) { return t.id === tourId; })[0];
      if (match) selectTour(match);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    fetch("data/tours.json")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load tours");
        return res.json();
      })
      .then(function (data) {
        TOURS = data;
        document.querySelectorAll(".location-tab").forEach(function (tab) {
          tab.addEventListener("click", function () { selectLocation(tab.dataset.location); });
        });
        $("tour-purchase-form").addEventListener("input", syncFromInputs);
        $("tour-purchase-form").addEventListener("change", syncFromInputs);
        $("tour-purchase-form").addEventListener("submit", function (e) {
          e.preventDefault();
          syncFromInputs();
          if (!validate()) return;
          submitPurchase();
        });
        initFromUrl();
      })
      .catch(function () {
        $("tour-grid").innerHTML =
          "<p class=\"placeholder-note\">Tours couldn't be loaded right now — please refresh the page or try again later.</p>";
      });
  });
})();
