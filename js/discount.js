/* discount.js — promo code UI + pricing hook for book.html. Loads after
   booking.js and registers a pricing hook via MadVervetBooking.setPricingHook
   (see js/booking.js header comment). The hook adjusts state AFTER booking.js's
   own totals are computed, so the base price-calc logic is untouched:
     reserve: amountDueAtCheckIn = subtotal − promoDiscount
     prepay:  amountChargedNow  = subtotal − max(promoDiscount, 10% prepay)
   The two discounts never stack. Client numbers are display-only — the server
   always re-validates the code and recalculates the amounts. */
(function () {
  "use strict";

  var applied = null; // { code, type, value, appliesTo } from validate-promo

  function $(id) { return document.getElementById(id); }
  function round2(n) { return Math.round(n * 100) / 100; }
  function money(n) { return "$" + round2(n).toFixed(2); }

  function noteEl() {
    var btn = $("bk-discount-apply");
    return btn ? btn.closest(".field").querySelector(".price-note") : null;
  }

  function setNote(msg, isError) {
    var el = noteEl();
    if (!el) return;
    el.className = isError ? "price-note field-error" : "price-note";
    el.textContent = msg;
  }

  function discountFor(subtotal) {
    var raw = applied.type === "percent"
      ? subtotal * (applied.value / 100)
      : Math.min(applied.value, subtotal);
    return round2(Math.max(0, Math.min(raw, subtotal)));
  }

  function locationOk(state) {
    return ["all", "rooms"].indexOf(applied.appliesTo) !== -1 || applied.appliesTo === state.location;
  }

  /* Pricing hook: runs at the end of booking.js recalculateTotal(). */
  function adjust(state) {
    state.promoCode = applied ? applied.code : null;
    state.promoDiscount = 0;
    state.promoDiscountApplied = false;
    if (!applied || state.subtotal <= 0 || !locationOk(state)) return;
    var promo = discountFor(state.subtotal);
    if (state.paymentOption === "prepay") {
      if (promo <= round2(state.subtotal * 0.1)) return; // 10% prepay wins — promo not applied
      state.amountChargedNow = round2(state.subtotal - promo);
    } else {
      state.amountDueAtCheckIn = round2(state.subtotal - promo);
    }
    state.promoDiscount = promo;
    state.promoDiscountApplied = true;
  }

  /* Pricing hook: extra summary lines injected after "Subtotal". */
  function promoLines(state) {
    if (!applied) return [];
    if (!locationOk(state)) return [["Promo " + applied.code, "not valid for this location"]];
    if (state.promoDiscountApplied && state.paymentOption === "reserve") {
      return [["Promo " + applied.code, "−" + money(state.promoDiscount)]];
    }
    if (state.promoDiscountApplied) return []; // prepay: discount line label shows "Promo CODE"
    return [["Promo " + applied.code, "10% prepay discount saves more"]];
  }

  function showApplied() {
    var el = noteEl();
    if (!el) return;
    el.className = "price-note";
    el.innerHTML = "Code <strong>" + applied.code + "</strong> applied. ";
    var remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn--ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", removePromo);
    el.appendChild(remove);
  }

  function removePromo() {
    applied = null;
    $("bk-discount").value = "";
    setNote("Promo code removed.");
    window.MadVervetBooking.recalculateTotal();
  }

  function apply(code) {
    setNote("Checking code…");
    fetch("/.netlify/functions/validate-promo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code, location: window.MadVervetBooking.state.location })
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.valid) { setNote(body.error || "Invalid promo code.", true); return; }
        applied = { code: body.code, type: body.type, value: body.value, appliesTo: body.appliesTo };
        window.MadVervetBooking.recalculateTotal();
        showApplied();
      })
      .catch(function () { setNote("Couldn't validate the code right now — try again.", true); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var input = $("bk-discount");
    var btn = $("bk-discount-apply");
    if (!input || !btn || !window.MadVervetBooking) return;
    input.disabled = false;
    btn.disabled = false;
    input.placeholder = "Promo code";
    setNote("Have a promo code? Apply it before submitting.");
    btn.addEventListener("click", function () {
      var code = input.value.trim();
      if (code) apply(code);
    });
    window.MadVervetBooking.setPricingHook({ adjust: adjust, promoLines: promoLines });
    var urlCode = new URLSearchParams(window.location.search).get("promo");
    if (urlCode) {
      input.value = urlCode;
      apply(urlCode);
    }
  });
})();
