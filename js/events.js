/* events.js — location tabs + event cards for events.html.
   Event data is loaded from data/events.json (keyed by hostel location). */
(function () {
  "use strict";

  var EVENTS = null; // loaded from data/events.json

  function $(id) { return document.getElementById(id); }

  function currentEvents() {
    var loc = document.querySelector(".location-tab--active");
    var key = loc ? loc.dataset.location : "addis-ababa";
    return (EVENTS && EVENTS[key]) ? EVENTS[key].events : [];
  }

  function renderEvents() {
    var grid = $("event-grid");
    grid.innerHTML = "";
    currentEvents().forEach(function (ev) {
      var card = document.createElement("article");
      card.className = "card card--bg";
      if (ev.image) card.style.backgroundImage = "url('" + ev.image + "')";
      card.innerHTML =
        "<span class=\"tag tag--pink\">" + ev.schedule + "</span>" +
        "<h3>" + ev.name + "</h3>" +
        "<p>" + ev.description + "</p>";
      grid.appendChild(card);
    });
  }

  function selectLocation(loc) {
    document.querySelectorAll(".location-tab").forEach(function (tab) {
      var active = tab.dataset.location === loc;
      tab.classList.toggle("location-tab--active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    renderEvents();
  }

  document.addEventListener("DOMContentLoaded", function () {
    fetch("data/events.json")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load events");
        return res.json();
      })
      .then(function (data) {
        EVENTS = data;
        document.querySelectorAll(".location-tab").forEach(function (tab) {
          tab.addEventListener("click", function () { selectLocation(tab.dataset.location); });
        });
        var loc = new URLSearchParams(window.location.search).get("location");
        selectLocation(EVENTS[loc] ? loc : "addis-ababa");
      })
      .catch(function () {
        $("event-grid").innerHTML =
          "<p class=\"placeholder-note\">Events couldn't be loaded right now — please refresh the page or try again later.</p>";
      });
  });
})();
