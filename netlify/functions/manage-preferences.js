const crypto = require('crypto');

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const LINK_SIGNING_SECRET = process.env.LINK_SIGNING_SECRET;
const SUPPORT_EMAIL = process.env.METHODLY_SUPPORT_EMAIL || 'results@methodly.me';

const CONSENT_LANGUAGE = 'Recipient updated SMS/email consent preferences via the Methodly preference center link.';

function hubspotHeaders() {
  return {
    'Authorization': 'Bearer ' + HUBSPOT_TOKEN,
    'Content-Type': 'application/json'
  };
}

function sign(payloadObj) {
  const body = Buffer.from(JSON.stringify(payloadObj))
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = crypto.createHmac('sha256', LINK_SIGNING_SECRET).update(body).digest('hex');
  return body + '.' + sig;
}

function verifyToken(token) {
  if (!token || !LINK_SIGNING_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac('sha256', LINK_SIGNING_SECRET).update(body).digest('hex');
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
      properties: ['email', 'sms_consent', 'email_consent'],
      limit: 1
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results && data.results[0] ? data.results[0] : null;
}

async function updateConsent(contactId, smsConsent, emailConsent) {
  const now = new Date().toISOString();
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
    method: 'PATCH',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      properties: {
        sms_consent: smsConsent ? 'true' : 'false',
        email_consent: emailConsent ? 'true' : 'false',
        consent_timestamp: now,
        consent_source: 'preference_center',
        consent_language: CONSENT_LANGUAGE
      }
    })
  });
  return res.ok;
}

function layout(title, inner) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + ' &middot; Methodly</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
    'background:#0f172a;color:#e2e8f0;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '.card{background:#1e293b;max-width:520px;margin:24px;padding:40px;border-radius:16px;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.4)}h1{margin:0 0 8px;font-size:24px;color:#fff;text-align:center}' +
    'p{line-height:1.6;color:#cbd5e1}label{display:flex;align-items:flex-start;gap:12px;margin:18px 0;' +
    'padding:16px;background:#0f172a;border-radius:10px;cursor:pointer}label input{margin-top:3px;width:18px;height:18px}' +
    'button{width:100%;padding:14px;background:#38bdf8;color:#0f172a;border:0;border-radius:10px;' +
    'font-size:16px;font-weight:600;cursor:pointer;margin-top:8px}.muted{font-size:13px;color:#94a3b8;' +
    'text-align:center;margin-top:24px}a{color:#38bdf8}</style></head><body><div class="card">' +
    '<h1>' + title + '</h1>' + inner +
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

function checked(v) { return String(v) === 'true' ? ' checked' : ''; }

exports.handler = async (event) => {
  const isPost = event.httpMethod === 'POST';
  const params = event.queryStringParameters || {};
  let token = params.token;
  let body = {};
  if (isPost) {
    const ct = (event.headers['content-type'] || '').toLowerCase();
    if (ct.indexOf('application/json') !== -1) {
      try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
    } else {
      body = Object.fromEntries(new URLSearchParams(event.body || ''));
    }
    token = token || body.token;
  }

  const data = verifyToken(token);
  if (!data || !data.email) {
    return respond(400, layout('Invalid or expired link',
      '<p>This preferences link is invalid or has expired. Please email ' + SUPPORT_EMAIL +
      ' and we will update your preferences.</p>'));
  }

  try {
    const contact = await findContactByEmail(data.email);

    if (!isPost) {
      const sms = contact ? contact.properties.sms_consent : 'false';
      const em = contact ? contact.properties.email_consent : 'false';
      const form =
        '<p>Manage how Methodly follows up with you. Uncheck a box to stop that type of contact.</p>' +
        '<form method="POST">' +
        '<input type="hidden" name="token" value="' + token + '">' +
        '<label><input type="checkbox" name="email_consent" value="true"' + checked(em) + '>' +
        '<span><strong>Email follow-up</strong><br>Receive emails from Methodly about your inquiry and services.</span></label>' +
        '<label><input type="checkbox" name="sms_consent" value="true"' + checked(sms) + '>' +
        '<span><strong>SMS / text follow-up</strong><br>Receive text messages from Methodly. Msg &amp; data rates may apply.</span></label>' +
        '<button type="submit">Save preferences</button></form>';
      return respond(200, layout('Your communication preferences', form));
    }

    const emailConsent = body.email_consent === 'true';
    const smsConsent = body.sms_consent === 'true';
    if (contact) {
      await updateConsent(contact.id, smsConsent, emailConsent);
    }
    return respond(200, layout('Preferences saved',
      '<p>Your preferences have been updated.</p>' +
      '<p>Email follow-up: <strong>' + (emailConsent ? 'On' : 'Off') + '</strong><br>' +
      'SMS follow-up: <strong>' + (smsConsent ? 'On' : 'Off') + '</strong></p>'));
  } catch (err) {
    console.error('manage-preferences error', err && err.message);
    return respond(500, layout('Something went wrong',
      '<p>We could not update your preferences automatically. Please email ' + SUPPORT_EMAIL + '.</p>'));
  }
};
