/* gallery.js — click-to-swap thumbnail galleries. Any .gallery block with a
   .gallery-main image and .gallery-thumb images gets thumbnail activation:
   clicking (or Enter/Space on) a thumb swaps it into the main view.
   Exposes window.initGalleries(root) so dynamically injected galleries
   (e.g. the booking room detail panel) can be initialised too. */
(function () {
  "use strict";

  function initGallery(gallery) {
    var main = gallery.querySelector(".gallery-main");
    var thumbs = gallery.querySelectorAll(".gallery-thumb");
    if (!main || !thumbs.length) return;
    thumbs.forEach(function (thumb) {
      function activate() {
        main.src = thumb.src;
        main.alt = thumb.alt;
        thumbs.forEach(function (t) { t.classList.remove("gallery-thumb--active"); });
        thumb.classList.add("gallery-thumb--active");
      }
      thumb.addEventListener("click", activate);
      thumb.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    });
  }

  window.initGalleries = function (root) {
    (root || document).querySelectorAll(".gallery").forEach(function (g) {
      if (g.dataset.galleryInit) return;
      g.dataset.galleryInit = "true";
      initGallery(g);
    });
  };

  document.addEventListener("DOMContentLoaded", function () {
    window.initGalleries();
  });
})();
