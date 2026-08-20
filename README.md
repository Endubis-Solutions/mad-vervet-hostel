# Mad Vervet Hostel

Static site + Netlify Functions backend for Mad Vervet Hostel (Addis Ababa & Nairobi).

Frontend: plain HTML/CSS/JS with shared partials (`partials/`) injected by `js/include.js`.
Backend: Netlify Functions (Node.js 20.x) in `netlify/functions/` — bookings (reserve or Stripe
prepay), a Stripe webhook, and tour/group/contact inquiry emails via Resend.

## Setup

```bash
npm install
cp .env.example .env   # then fill in real values (never commit .env)
```

### Environment variables

| Variable | Description |
| --- | --- |
| `STRIPE_SECRET_KEY` | Stripe secret key — used by `create-checkout-session` and `stripe-webhook` (server-side only). |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key — reserved for future client-side Stripe use; not currently referenced by any page. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the `stripe-webhook` function (from `stripe listen` locally, or the Dashboard webhook in prod). |
| `RESEND_API_KEY` | Resend API key for all outgoing email. If unset, emails are skipped with a warning and requests still succeed. |
| `HOSTEL_NOTIFICATION_EMAIL` | Inbox that receives booking + inquiry notifications (default fallback: `info@madvervet.com`). |
| `EMAIL_FROM` | Sender address for outgoing mail. Default: `Mad Vervet Hostel <bookings@madvervet.com>` (requires the verified domain). For dev/testing use `Mad Vervet Hostel <onboarding@resend.dev>` — test mode only delivers to your Resend account email. |

| `ANTHROPIC_API_KEY` | Anthropic API key for the `ai-chat` FAQ function (server-side only). If unset, the function returns a graceful fallback reply pointing to WhatsApp. |
| `WHATSAPP_BUSINESS_NUMBER` | Reference copy of the WhatsApp number used by the chat widget. The number is **also hardcoded in `js/chat-widget.js`** (static JS can't read env vars) — keep the two in sync. |

## Chat widget (AI FAQ)

Every page loads `js/chat-widget.js`, which renders a floating chat bubble into
`#chat-widget-mount` (part of `partials/footer.html`). Quick-reply answers are
hardcoded client-side (no network calls); free-text questions go to
`/.netlify/functions/ai-chat`, which calls the Anthropic Messages API with a
Haiku-class model and a system prompt grounded in the site's real facts. A
"Chat with our team on WhatsApp" button is always visible in the widget and
prefills the guest's last question.

### Sending domain

Email is sent via Resend from the address in `EMAIL_FROM` (default:
`Mad Vervet Hostel <bookings@madvervet.com>`). The `madvervet.com` domain must
be verified in the Resend dashboard for production. Until then, set
`EMAIL_FROM="Mad Vervet Hostel <onboarding@resend.dev>"` — Resend's test sender,
which only delivers to your own Resend account email.

## Local development

```bash
netlify dev
```

This serves the site and the functions at `http://localhost:8888`
(functions at `/.netlify/functions/<name>`). A dev server is required — the shared
header/footer partials load via `fetch()`, which browsers block over `file://`.

## Stripe

- The prepay flow charges a server-computed amount — subtotal minus the larger of the
  10% prepay discount or an applied promo code (never stacked) — via a Stripe Checkout
  Session in payment mode, USD. The reserve flow never touches Stripe.
- Stripe API version is pinned to `2024-06-20` in the function client config.
- Webhook endpoint: `/.netlify/functions/stripe-webhook`, event `checkout.session.completed`.
  The signature is verified with `STRIPE_WEBHOOK_SECRET`; unverified requests get a 400.

Forward webhooks locally with the Stripe CLI:

```bash
stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook
```

Copy the `whsec_...` secret it prints into `.env` as `STRIPE_WEBHOOK_SECRET`.

## Deploying to Netlify

1. Push the repo and connect it in Netlify (no build command needed — static files are
   published as-is; `netlify.toml` points functions at `netlify/functions`).
2. Set the env vars above in Site settings → Environment variables.
3. Add a webhook in the Stripe Dashboard pointing at
   `https://<your-site>/.netlify/functions/stripe-webhook` with
   `checkout.session.completed`, and set its signing secret as `STRIPE_WEBHOOK_SECRET`.

Node.js 20.x is pinned via `NODE_VERSION = "20"` in `netlify.toml` and `engines` in
`package.json`.

## Promo codes

Codes live in `data/promo-codes.json` (`type`: `percent`|`flat`; `appliesTo`:
`all`|`rooms`|`<location-slug>`; `rooms` currently discounts the whole subtotal —
see `netlify/functions/lib/promo.js`). The booking page validates codes via
`/.netlify/functions/validate-promo` (read-only, never increments usage) and also
auto-applies a `?promo=CODE` URL parameter. Servers always re-validate and
recompute: the reserve path subtracts the promo from the check-in amount; the
prepay path charges subtotal minus the **larger** of the promo or the 10% prepay
discount (never stacked). `usedCount` increments only when the promo was the
discount actually applied and the booking is confirmed (reservation submitted /
`checkout.session.completed` webhook).

> **NOTE — dev-only persistence:** `usedCount` is persisted by writing
> `data/promo-codes.json`. That works under `netlify dev` but **not** in deployed
> production, where the functions filesystem is read-only — the write fails, a
> warning is logged, and the booking still succeeds (usage is just not counted).
> Before relying on `maxUses` in production, move codes to a database or KV store
> (e.g. Netlify Blobs, Upstash, DynamoDB).
