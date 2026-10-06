/* upsell.js — tour upsell on booking-confirmation.html. After a room booking
   we promote the Addis City Tour: "get your bearings in Addis and make the
   best of your short time", with 30% off every additional guest (up to 3
   people per tour). The group discount applies to the City Tour only — no
   other tour. The "Book" button deep-links to tours.html with the tour
   preselected and the 5% guest discount applied (?discount=guest). */
(function () {
  "use strict";

  var CITY_TOUR_ID = "addis-city-tour";

  function $(id) { return document.getElementById(id); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return "$" + round2(n).toFixed(2); }

  function renderUpsell(data) {
    var section = $("upsell-section");
    var grid = $("upsell-grid");
    if (!section || !grid || !data.ethiopia) return;
    var tour = data.ethiopia.tours.filter(function (t) { return t.id === CITY_TOUR_ID; })[0];
    if (!tour) return;
    var card = document.createElement("article");
    card.className = "card card--pink card--bg";
    if (tour.image) card.style.backgroundImage = "url('" + tour.image + "')";
    card.innerHTML =
      "<h3>" + tour.name + "</h3>" +
      "<p><span class=\"tag\">" + tour.duration + "</span></p>" +
      "<p>Get your bearings in Addis and make the best of your short time — the National Museum, Merkato, Entoto Hills and a traditional coffee ceremony, all in one day.</p>" +
      "<p><strong>" + money(tour.price) + "/person</strong></p>" +
      "<p class=\"price-note\"><strong>30% discounts on groups</strong> — every additional guest is 30% off (up to 3 people per tour). Confirmed guests save an extra 5%.</p>";
    var btn = document.createElement("a");
    btn.className = "btn";
    btn.href = "tours.html?tour=" + tour.id + "&discount=guest";
    btn.textContent = "Book the City Tour";
    card.appendChild(btn);
    grid.appendChild(card);
    section.hidden = false;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var loc = new URLSearchParams(window.location.search).get("location");
    if (loc && loc !== "addis-ababa") return; // the City Tour runs in Addis only
    fetch("data/tours.json")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load tours");
        return res.json();
      })
      .then(function (data) { renderUpsell(data); })
      .catch(function () { /* upsell is optional — fail silently */ });
  });
})();
