/* chat-widget.js — floating FAQ chat bubble, rendered into #chat-widget-mount
   (injected with the footer partial by js/include.js). Because the footer is
   fetched asynchronously, init polls for the mount point instead of assuming
   it exists. Quick replies are hardcoded instant answers (zero network calls);
   free-text questions go to POST /.netlify/functions/ai-chat.
   NOTE: the WhatsApp number is hardcoded here because static JS can't read
   env vars — keep it in sync with WHATSAPP_BUSINESS_NUMBER in .env.example. */
(function () {
  "use strict";

  var WHATSAPP_NUMBER = "251923577808";
  var CHAT_ENDPOINT = "/.netlify/functions/ai-chat";
  var MAX_MESSAGE = 500;
  var POLL_MS = 200;
  var POLL_LIMIT = 50; // ~10s

  var INTRO_MSG = "Hey! I'm the Mad Vervet bot — automated answers, not a staff member. " +
    "Pick a topic below or type a question. For a human, use the WhatsApp button anytime.";
  var ERROR_MSG = "Oops, my brain glitched — I couldn't get an answer just now. " +
    "Try again, or tap the WhatsApp button below to chat with our team.";

  var QUICK_REPLIES = [
    { label: "Check-in / check-out times", answer:
      "Check-in is from 2:00 PM and check-out is by 11:00 AM. " +
      "Reception in Addis Ababa is staffed 24 hours, so late arrivals are fine — just let us know." },
    { label: "Cancellation policy", answer:
      "Free cancellation if you booked 24 hours or more before your arrival day. " +
      "Cancellations inside 24 hours may be charged the first night, and no-shows are charged the first night." },
    { label: "Private rooms", answer:
      "Yes, both locations have private rooms! Addis Ababa: Private Single $18 and Private Double $25 " +
      "(breakfast included). Nairobi: Private Rooms from $20. Grab one on the booking page (book.html)." },
    { label: "Is breakfast included?", answer:
      "In Addis Ababa we serve daily breakfast (continental / vegan / halal), and it's included with the " +
      "Private Double. Otherwise you can add daily breakfast for $5/day per guest when you book." },
    { label: "Airport transport", answer:
      "Addis Ababa is about 10 minutes from Bole International Airport — we run a paid airport shuttle, " +
      "and you can add airport pickup/drop-off for $15 flat (one-way) when booking. " +
      "Nairobi is about 15 minutes from Wilson Airport." },
    { label: "Tours", answer:
      "Yes! Tours are inquiry-based — send a request via tours.html and our staff will follow up " +
      "with a quote and options." },
    { label: "Group bookings", answer:
      "Travelling with a crew? Group bookings are inquiry-based — head to groups.html, tell us your " +
      "dates and group size, and we'll get back to you." }
  ];

  var lastQuestion = null;
  var els = {}; // mount, bubble, panel, log, form, input, whatsapp

  function whatsappUrl() {
    var text = lastQuestion
      ? "Hi Mad Vervet! I asked your chatbot: \"" + lastQuestion.slice(0, 120) +
        "\" — could the team help me with this?"
      : "Hi Mad Vervet! I have a question.";
    return "https://wa.me/" + WHATSAPP_NUMBER + "?text=" + encodeURIComponent(text);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function addMessage(text, from) {
    var msg = el("p", "chat-msg chat-msg--" + from, text);
    els.log.appendChild(msg);
    els.log.scrollTop = els.log.scrollHeight;
    return msg;
  }

  function renderQuickReplies() {
    var wrap = el("div", "chat-quick");
    QUICK_REPLIES.forEach(function (qr) {
      var btn = el("button", "chat-quick-btn", qr.label);
      btn.type = "button";
      btn.addEventListener("click", function () {
        addMessage(qr.label, "user");
        addMessage(qr.answer, "bot"); // hardcoded — no network call
      });
      wrap.appendChild(btn);
    });
    els.log.appendChild(wrap);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function setLoading(on) {
    var spinner = els.log.querySelector(".chat-msg--loading");
    if (on && !spinner) {
      addMessage("Thinking…", "loading");
    } else if (!on && spinner) {
      spinner.remove();
    }
  }

  function requestReply(message) {
    setLoading(true);
    return fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: message })
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Request failed");
        return res.json();
      })
      .then(function (body) {
        setLoading(false);
        addMessage(body.reply || ERROR_MSG, "bot");
      })
      .catch(function () {
        setLoading(false);
        addMessage(ERROR_MSG, "bot");
      });
  }

  function onSubmit(e) {
    e.preventDefault();
    var message = els.input.value.trim().slice(0, MAX_MESSAGE);
    if (!message) return;
    els.input.value = "";
    lastQuestion = message;
    els.whatsapp.href = whatsappUrl();
    addMessage(message, "user");
    requestReply(message);
  }

  function togglePanel(open) {
    els.panel.hidden = !open;
    els.bubble.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      if (!els.log.hasChildNodes()) {
        addMessage(INTRO_MSG, "bot");
        renderQuickReplies();
      }
      els.input.focus();
    } else {
      els.bubble.focus();
    }
  }

  function buildBubble() {
    var bubble = el("button", "chat-bubble", "Chat");
    bubble.type = "button";
    bubble.setAttribute("aria-label", "Open chat — Mad Vervet FAQ bot");
    bubble.setAttribute("aria-expanded", "false");
    bubble.addEventListener("click", function () { togglePanel(els.panel.hidden); });
    return bubble;
  }

  function buildPanel() {
    var panel = el("div", "chat-panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Mad Vervet FAQ chat");

    var head = el("div", "chat-panel-head");
    head.appendChild(el("strong", "", "Mad Vervet Bot"));
    var close = el("button", "chat-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close chat");
    close.addEventListener("click", function () { togglePanel(false); });
    head.appendChild(close);
    panel.appendChild(head);

    els.log = el("div", "chat-log");
    els.log.setAttribute("aria-live", "polite");
    panel.appendChild(els.log);

    els.whatsapp = el("a", "chat-whatsapp", "Chat with our team on WhatsApp");
    els.whatsapp.href = whatsappUrl();
    els.whatsapp.target = "_blank";
    els.whatsapp.rel = "noopener";
    panel.appendChild(els.whatsapp);

    els.form = el("form", "chat-form");
    els.input = document.createElement("input");
    els.input.type = "text";
    els.input.maxLength = MAX_MESSAGE;
    els.input.placeholder = "Ask a question…";
    els.input.setAttribute("aria-label", "Type your question");
    var send = el("button", "btn chat-send", "Send");
    send.type = "submit";
    els.form.appendChild(els.input);
    els.form.appendChild(send);
    els.form.addEventListener("submit", onSubmit);
    panel.appendChild(els.form);

    return panel;
  }

  function init(mount) {
    els.mount = mount;
    els.bubble = buildBubble();
    els.panel = buildPanel();
    mount.appendChild(els.panel);
    mount.appendChild(els.bubble);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !els.panel.hidden) togglePanel(false);
    });
  }

  function waitForMount(attempts) {
    var mount = document.getElementById("chat-widget-mount");
    if (mount) return init(mount);
    if (attempts <= 0) return; // footer never loaded — give up quietly
    setTimeout(function () { waitForMount(attempts - 1); }, POLL_MS);
  }

  document.addEventListener("DOMContentLoaded", function () {
    waitForMount(POLL_LIMIT);
  });
})();
