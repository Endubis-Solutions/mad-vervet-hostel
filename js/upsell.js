/* upsell.js — tour upsell on booking-confirmation.html. Reads the booked
   hostel location from the ?location= query param, loads the matching
   country's tours from data/tours.json and offers them to the guest:
   5% guest discount, plus another 5% (10% total) for paying online now.
   The "Book" buttons deep-link to tours.html with the tour preselected and
   the guest discount applied (?discount=guest). */
(function () {
  "use strict";

  var GUEST_RATE = 0.05;   // 5% guest discount
  var PAYNOW_RATE = 0.05;  // extra 5% for paying online now
  var LOCATION_TO_COUNTRY = { "addis-ababa": "ethiopia", nairobi: "kenya" };

  function $(id) { return document.getElementById(id); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return "$" + round2(n).toFixed(2); }

  function renderUpsell(country, data) {
    var section = $("upsell-section");
    var grid = $("upsell-grid");
    if (!section || !grid || !data[country]) return;
    data[country].tours.forEach(function (tour) {
      var guestPrice = round2(tour.price * (1 - GUEST_RATE));
      var paynowPrice = round2(tour.price * (1 - GUEST_RATE - PAYNOW_RATE));
      var card = document.createElement("article");
      card.className = "card card--pink card--bg";
      if (tour.image) card.style.backgroundImage = "url('" + tour.image + "')";
      card.innerHTML =
        "<h3>" + tour.name + "</h3>" +
        "<p><span class=\"tag\">" + tour.duration + "</span></p>" +
        "<p>" + tour.description + "</p>" +
        "<p><span class=\"price-old\">" + money(tour.price) + "</span>" +
        "<span class=\"price-new\">" + money(guestPrice) + "/person</span> " +
        "<span class=\"price-note\">(5% guest price)</span></p>" +
        "<p class=\"price-note\">Pay online now: <strong>" + money(paynowPrice) +
        "/person</strong> (10% off total)</p>";
      var btn = document.createElement("a");
      btn.className = "btn";
      btn.href = "tours.html?location=" + country + "&tour=" + tour.id + "&discount=guest";
      btn.textContent = "Book This Tour";
      card.appendChild(btn);
      grid.appendChild(card);
    });
    section.hidden = false;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var loc = new URLSearchParams(window.location.search).get("location");
    var country = LOCATION_TO_COUNTRY[loc];
    if (!country) return; // unknown/no location — no upsell
    fetch("data/tours.json")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load tours");
        return res.json();
      })
      .then(function (data) { renderUpsell(country, data); })
      .catch(function () { /* upsell is optional — fail silently */ });
  });
})();
