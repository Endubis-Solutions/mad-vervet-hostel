/* include.js — injects shared header/footer partials via fetch().
   NOTE: partials only load over HTTP(S); a local dev server is required
   (fetch() over file:// is blocked by browsers). */
(function () {
  "use strict";

  function inject(targetId, url) {
    var el = document.getElementById(targetId);
    if (!el) return Promise.resolve(false);
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load " + url);
        return res.text();
      })
      .then(function (html) {
        el.innerHTML = html;
        return true;
      })
      .catch(function (err) {
        console.error(err);
        return false;
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    inject("site-header", "partials/header.html").then(function (ok) {
      // Header is in the DOM now — initialise the nav (hamburger, etc.)
      if (ok && typeof window.initNav === "function") {
        window.initNav();
      } else {
        document.dispatchEvent(new CustomEvent("site:header-ready"));
      }
    });
    inject("site-footer", "partials/footer.html");
  });
})();
