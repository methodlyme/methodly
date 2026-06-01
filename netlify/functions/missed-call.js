const crypto = require('crypto');

// ---- Environment ----
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.METHODLY_FROM_EMAIL || 'angela@methodly.me';
const SUPPORT_EMAIL = process.env.METHODLY_SUPPORT_EMAIL || 'results@methodly.me';
const BOOKING_URL = process.env.METHODLY_BOOKING_URL || 'https://methodly.me';

const GREETING =
  'Thank you for calling Methodly. We help you recover lost revenue by following up with leads ' +
  'quickly and professionally. We\'re sorry we missed your call. Please leave your name, phone number, ' +
  'business name, and a brief message after the tone, and we\'ll get back to you as soon as possible.';

// ---- Helpers ----
function hubspotHeaders() {
  return { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' };
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlResponse(twiml) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
    body: '<?xml version="1.0" encoding="UTF-8"?>' + twiml
  };
}

// Validate Twilio request signature (HMAC-SHA1, base64). Returns true/false.
function validateTwilioSignature(event) {
  const signature = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
  if (!signature || !TWILIO_AUTH_TOKEN) return false;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['host'] || event.headers['Host'];
  const url = proto + '://' + host + event.path + (event.rawQuery ? '?' + event.rawQuery : '');
  const params = new URLSearchParams(event.body || '');
  const sorted = [...params.keys()].sort();
  let data = url;
  for (const key of sorted) data += key + params.get(key);
  const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

async function findContactByPhone(phone) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
    method: 'POST',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }],
      properties: ['email', 'phone', 'firstname', 'sms_consent', 'email_consent'],
      limit: 1
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.results && data.results[0] ? data.results[0] : null;
}

async function createContactByPhone(phone) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    method: 'POST',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      properties: {
        phone: phone,
        hs_lead_status: 'NEW',
        lifecyclestage: 'lead'
      }
    })
  });
  if (!res.ok) return null;
  return res.json();
}

async function logNote(contactId, lines) {
  const now = new Date().toISOString();
  const body = lines.join('\n');
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
    method: 'POST',
    headers: hubspotHeaders(),
    body: JSON.stringify({
      properties: { hs_note_body: body, hs_timestamp: now },
      associations: contactId ? [{
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
      }] : []
    })
  });
  return res.ok;
}

async function sendSms(to, message) {
  const creds = Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
  const params = new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Body: message });
  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  return res.ok;
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Methodly <' + FROM_EMAIL + '>', to: [to], subject: subject, html: html })
  });
  return res.ok;
}

// ---- Handler ----
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  if (!validateTwilioSignature(event)) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  const params = new URLSearchParams(event.body || '');
  const query = event.queryStringParameters || {};
  const stage = query.stage || 'greeting';
  const host = event.headers['host'] || 'methodly.me';
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const actionUrl = proto + '://' + host + event.path + '?stage=recording';

  // ---- STAGE 1: initial inbound call -> greeting + record ----
  if (stage !== 'recording') {
    const twiml =
      '<Response>' +
        '<Say voice="Polly.Joanna">' + escapeXml(GREETING) + '</Say>' +
        '<Record action="' + escapeXml(actionUrl) + '" method="POST" maxLength="120" ' +
          'playBeep="true" finishOnKey="#" timeout="5" trim="trim-silence" />' +
        '<Say voice="Polly.Joanna">We did not receive a recording. Goodbye.</Say>' +
        '<Hangup/>' +
      '</Response>';
    return xmlResponse(twiml);
  }

  // ---- STAGE 2: recording callback -> CRM + consent-gated follow-up ----
  const from = params.get('From') || '';
  const recordingUrl = params.get('RecordingUrl') || '';
  const callTime = new Date().toISOString();

  let contact = null;
  let isNew = false;
  let smsConsent = false;
  let emailConsent = false;
  let email = '';

  try {
    contact = await findContactByPhone(from);
    if (!contact) {
      const created = await createContactByPhone(from);
      contact = created;
      isNew = true;
    } else {
      const p = contact.properties || {};
      smsConsent = String(p.sms_consent) === 'true';
      emailConsent = String(p.email_consent) === 'true';
      email = p.email || '';
    }
  } catch (e) {
    console.error('hubspot lookup/create error', e && e.message);
  }

  const contactId = contact && contact.id ? contact.id : null;

  // Decide follow-up
  let smsSent = false;
  let emailSent = false;
  try {
    if (smsConsent && from) {
      smsSent = await sendSms(from,
        'Thanks for calling Methodly! We got your voicemail and will follow up shortly. Reply STOP to opt out.');
    }
    if (emailConsent && email) {
      emailSent = await sendEmail(email, 'We received your voicemail - Methodly',
        '<p>Thanks for calling Methodly. We received your voicemail and will get back to you shortly.</p>' +
        '<p>In the meantime, you can book a time here: <a href="' + BOOKING_URL + '">' + BOOKING_URL + '</a></p>');
    }
    // Always notify internally
    await sendEmail(SUPPORT_EMAIL, 'New voicemail from ' + from,
      '<p>New inbound voicemail.</p><ul>' +
      '<li>From: ' + escapeXml(from) + '</li>' +
      '<li>Time: ' + escapeXml(callTime) + '</li>' +
      '<li>Recording: <a href="' + escapeXml(recordingUrl) + '">' + escapeXml(recordingUrl) + '</a></li>' +
      '<li>HubSpot contact: ' + (isNew ? 'created (phone only)' : 'existing') + '</li>' +
      '<li>SMS consent: ' + smsConsent + ' (sent: ' + smsSent + ')</li>' +
      '<li>Email consent: ' + emailConsent + ' (sent: ' + emailSent + ')</li>' +
      '</ul>');
  } catch (e) {
    console.error('follow-up error', e && e.message);
  }

  // Log HubSpot note
  try {
    await logNote(contactId, [
      'Inbound voicemail received',
      'Call time: ' + callTime,
      'Caller number: ' + from,
      'Voicemail recording: ' + recordingUrl,
      'Transcription: (not enabled)',
      'SMS consent: ' + smsConsent,
      'Email consent: ' + emailConsent,
      'Follow-up sent: ' +
        (smsSent ? 'SMS ' : '') + (emailSent ? 'Email ' : '') +
        (!smsSent && !emailSent ? 'none (internal notification only)' : '')
    ]);
  } catch (e) {
    console.error('note error', e && e.message);
  }

  // Thank the caller and hang up
  const twiml =
    '<Response>' +
      '<Say voice="Polly.Joanna">Thank you. Your message has been received. Goodbye.</Say>' +
      '<Hangup/>' +
    '</Response>';
  return xmlResponse(twiml);
};
