/* forms.js — shared client-side validation + submission for all forms.
   Expected backend endpoints (Netlify functions, not yet implemented):
     - tour inquiry   : POST /.netlify/functions/tour-inquiry
     - group inquiry  : POST /.netlify/functions/group-inquiry
     - contact        : POST /.netlify/functions/contact
   All accept a JSON body of the form fields. On any failure or non-OK
   response we show a friendly "not available yet" message. */
(function () {
  "use strict";

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var FALLBACK_MSG = "This feature isn't available yet — please email info@madvervet.com and we'll help you out.";

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

  function validateForm(form) {
    var valid = true;
    form.querySelectorAll("[required]").forEach(function (input) {
      clearError(input);
      var val = input.value.trim();
      if (!val) {
        showError(input, "This field is required.");
        valid = false;
      } else if (input.type === "email" && !EMAIL_RE.test(val)) {
        showError(input, "Please enter a valid email address.");
        valid = false;
      } else if (input.type === "number" && Number(val) < Number(input.min || 0)) {
        showError(input, "Please enter a number of at least " + input.min + ".");
        valid = false;
      }
    });
    return valid;
  }

  function collectData(form) {
    var data = {};
    new FormData(form).forEach(function (value, key) {
      data[key] = value;
    });
    return data;
  }

  function setStatus(form, msg, isOk) {
    var status = form.querySelector(".form-status");
    if (!status) {
      status = document.createElement("div");
      status.className = "form-status";
      status.setAttribute("role", "status");
      form.appendChild(status);
    }
    status.className = "form-status " + (isOk ? "form-status--ok" : "form-status--error");
    status.textContent = msg;
  }

  function bindForm(formId, endpoint) {
    var form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (!validateForm(form)) return;
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectData(form))
      })
        .then(function (res) {
          if (!res.ok) throw new Error("Request failed");
          setStatus(form, "Thanks! Your message has been sent — we'll be in touch soon.", true);
          form.reset();
        })
        .catch(function () {
          setStatus(form, FALLBACK_MSG, false);
        });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindForm("tour-inquiry-form", "/.netlify/functions/tour-inquiry");
    bindForm("group-inquiry-form", "/.netlify/functions/group-inquiry");
    bindForm("contact-form", "/.netlify/functions/contact");
  });
})();
