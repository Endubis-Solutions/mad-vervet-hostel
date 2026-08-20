/* nav.js — mobile hamburger toggle. Initialised by include.js after the
   header partial is injected (or on DOMContentLoaded as a fallback). */
(function () {
  "use strict";

  window.initNav = function () {
    var toggle = document.getElementById("nav-toggle");
    var nav = document.getElementById("main-nav");
    if (!toggle || !nav || toggle.dataset.navInit) return;
    toggle.dataset.navInit = "true";

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  };

  document.addEventListener("DOMContentLoaded", function () {
    window.initNav();
  });
})();
