const crypto = require('crypto');

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const LINK_SIGNING_SECRET = process.env.LINK_SIGNING_SECRET;
const SUPPORT_EMAIL = process.env.METHODLY_SUPPORT_EMAIL || 'results@methodly.me';

const CONSENT_LANGUAGE = 'Recipient unsubscribed from Methodly email follow-up via one-click email link.';

function hubspotHeaders() {
  return {
    'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
    'Content-Type': 'application/json'
  };
}

// Verify an HMAC-signed token of the form: base64url(payloadJson).hexHmac
function verifyToken(token) {
  if (!token || !LINK_SIGNING_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', LINK_SIGNING_SECRET)
    .update(body)
    .digest('hex');
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

async function findContactByEmail(email) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
      properties: ['email', 'email_consent'],
      limit: 1
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results && data.results[0] ? data.results[0] : null;
}

async function setEmailConsentFalse(contactId) {
  const now = new Date().toISOString();
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
    method: 'PATCH',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      properties: {
        email_consent: 'false',
        consent_timestamp: now,
        consent_source: 'email_unsubscribe_link',
        consent_language: CONSENT_LANGUAGE
      }
    })
  });
  return res.ok;
}

function page(title, message) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + ' &middot; Methodly</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'background:#0f172a;color:#e2e8f0;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.card{background:#1e293b;max-width:520px;margin:24px;padding:40px;border-radius:16px;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.4);text-align:center}' +
    'h1{margin:0 0 12px;font-size:24px;color:#fff}p{line-height:1.6;color:#cbd5e1}' +
    'a{color:#38bdf8}.muted{font-size:13px;color:#94a3b8;margin-top:24px}</style></head>' +
    '<body><div class="card"><h1>' + title + '</h1><p>' + message + '</p>' +
    '<p class="muted">Methodly &middot; 15300 N 90th St, Scottsdale, AZ 85260<br>' +
    'Questions? Email ' + SUPPORT_EMAIL + '</p></div></body></html>';
}

function respond(statusCode, html) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    body: html
  };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const token = params.token;
  const data = verifyToken(token);

  if (!data || !data.email) {
    return respond(400, page('Invalid or expired link',
      'This unsubscribe link is invalid or has expired. Please email ' + SUPPORT_EMAIL +
      ' and we will remove you from email follow-up right away.'));
  }

  try {
    const contact = await findContactByEmail(data.email);
    if (contact) {
      await setEmailConsentFalse(contact.id);
    }
    return respond(200, page('You are unsubscribed',
      'You will no longer receive marketing or follow-up emails from Methodly. ' +
      'If this was a mistake, you can re-subscribe anytime by submitting the contact form on methodly.me.'));
  } catch (err) {
    console.error('unsubscribe error', err && err.message);
    return respond(500, page('Something went wrong',
      'We could not process your request automatically. Please email ' + SUPPORT_EMAIL +
      ' and we will remove you from email follow-up.'));
  }
};
