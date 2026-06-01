# Methodly

Marketing site + serverless automation for Methodly. All automation runs on Netlify Functions only; there is no external middleware.

## Stack

GitHub is the single source of truth (this repo); Netlify auto-deploys from `main`. Netlify provides static hosting plus the serverless functions that form the automation layer. Cloudflare handles DNS only. HubSpot is the CRM (contacts, deals, tasks). Twilio provides the phone number, voice webhook, and SMS. Resend sends transactional email from the verified methodly.me domain.

## Serverless functions

Both functions live under `netlify/functions/` and read every credential from Netlify environment variables (never hardcoded, never exposed client-side).

`contact.js` serves `/.netlify/functions/contact` and is the single source of truth for website form submissions. It validates input, then creates or updates a HubSpot contact, creates a HubSpot deal, creates a HubSpot follow-up task, sends the autoresponder email via Resend, and sends an SMS via Twilio when a phone number is supplied. Each downstream call is wrapped in its own try/catch so a temporary HubSpot, Twilio, or Resend outage never breaks the user-facing response; the function always returns a friendly success JSON.

`missed-call.js` serves `/.netlify/functions/missed-call` and is the Twilio voice webhook for missed-call recovery. It validates the inbound X-Twilio-Signature, creates or updates the HubSpot contact, sends an SMS follow-up, sends email via Resend if an address is known, logs a HubSpot note, and returns valid TwiML.

## Environment variables (set in Netlify, not in code)

See `.env.example` for the full list. Required keys:

```
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
HUBSPOT_PRIVATE_APP_TOKEN
RESEND_API_KEY
METHODLY_BOOKING_URL=https://meetings.hubspot.com/methodly
METHODLY_FROM_EMAIL=results@methodly.me
METHODLY_SUPPORT_EMAIL=results@methodly.me
```

## Deploy notes

Edits to `main` deploy automatically via Netlify. The contact form in `index.html` POSTs JSON to `/.netlify/functions/contact`. The Twilio number's Voice webhook should point at `https://methodly.me/.netlify/functions/missed-call`. The canonical legal pages are `privacy.html` and `terms.html`, linked from the site footer.
