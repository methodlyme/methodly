# Methodly

Marketing site + serverless automation for Methodly. No Zapier, no Make, no n8n. All automation runs on Netlify Functions.

## Stack

- GitHub — single source of truth (this repo). Netlify auto-deploys from `main`.
- Netlify — static hosting + serverless functions (the automation layer).
- Cloudflare — DNS only.
- HubSpot — CRM (contacts, deals, tasks).
- Twilio — phone number, voice webhook, SMS.
- Resend — transactional email (domain methodly.me, verified).

## Serverless functions

All live under `netlify/functions/` and read every credential from Netlify environment variables (never hardcoded, never exposed client-side).

### `contact.js` -> `/.netlify/functions/contact`
Single source of truth for website form submissions. Validates input, then: creates/updates a HubSpot contact, creates a HubSpot deal, creates a HubSpot follow-up task, sends the autoresponder email via Resend, and sends an SMS via Twilio when a phone number is supplied. Each downstream call is wrapped in its own try/catch so a temporary HubSpot/Twilio/Resend outage never breaks the user-facing response; the function always returns a friendly success JSON.

### `missed-call.js` -> `/.netlify/functions/missed-call`
Twilio voice webhook for missed-call recovery. Validates the inbound `X-Twilio-Signature`, creates/updates the HubSpot contact, sends an SMS follow-up, sends email if an address is known, logs a HubSpot note, and returns valid TwiML.

### `sms-webhook.js` (legacy)
Predates `missed-call.js`. Superseded and slated for removal once the Twilio number is repointed to `missed-call`.

## Environment variables (set in Netlify, not in code)

See `.env.example` for the full list. Required:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `HUBSPOT_PRIVATE_APP_TOKEN`
- `RESEND_API_KEY`
- `METHODLY_BOOKING_URL` (https://meetings.hubspot.com/methodly)
- `METHODLY_FROM_EMAIL` (results@methodly.me)
- `METHODLY_SUPPORT_EMAIL` (results@methodly.me)

## Local / deploy notes

- Edits to `main` deploy automatically via Netlify.
- The contact form (`index.html`) POSTs JSON to `/.netlify/functions/contact`.
- Point the Twilio number's Voice webhook at `https://methodly.me/.netlify/functions/missed-call`.
- Legal pages: `privacy-policy.html` and `terms-of-service.html` are canonical (netlify.toml redirects `/privacy`, `/privacy.html`, `/terms`, `/terms.html` to them).
