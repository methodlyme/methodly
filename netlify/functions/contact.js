// netlify/functions/contact.js
// Methodly website contact form handler. Single source of truth for all
// website form submissions. No external middleware. All secrets stay server-side in
// Netlify environment variables. The site always receives a success
// response even if a downstream service (HubSpot/Twilio/Resend) fails.

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BOOKING_URL = process.env.METHODLY_BOOKING_URL || 'https://meetings.hubspot.com/methodly';
const FROM_EMAIL = process.env.METHODLY_FROM_EMAIL || 'results@methodly.me';
const SUPPORT_EMAIL = process.env.METHODLY_SUPPORT_EMAIL || 'results@methodly.me';

const HUBSPOT_BASE = 'https://api.hubapi.com';

function hubspotHeaders() {
  return { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' };
}

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function logError(stage, err) {
  // Never log secrets. Only stage + message.
console.error('[contact] ' + stage + ': ' + (err && err.message ? err.message : String(err)));
}

async function findContact(email, phone) {
const filters = [];
if (email) filters.push({ propertyName: 'email', operator: 'EQ', value: email });
const body = { filterGroups: [], properties: ['email', 'phone', 'firstname'], limit: 1 };
if (email) {
body.filterGroups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] });
}
if (phone) {
body.filterGroups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] });
}
if (body.filterGroups.length === 0) return null;
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/contacts/search', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify(body) });
if (!res.ok) throw new Error('search ' + res.status);
const data = await res.json();
return data.results && data.results.length ? data.results[0] : null;
}

async function upsertContact(input) {
  const props = {};
if (input.email) props.email = input.email;
if (input.phone) props.phone = input.phone;
if (input.name) {
const parts = input.name.trim().split(' ');
props.firstname = parts.shift();
if (parts.length) props.lastname = parts.join(' ');
}
if (input.company) props.company = input.company;
if (input.message) props.message = input.message;
const existing = await findContact(input.email, input.phone);
if (existing) {
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/contacts/' + existing.id, { method: 'PATCH', headers: hubspotHeaders(), body: JSON.stringify({ properties: props }) });
if (!res.ok) throw new Error('update ' + res.status);
return existing.id;
}
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/contacts', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify({ properties: props }) });
if (!res.ok) throw new Error('create ' + res.status);
const data = await res.json();
return data.id;
}

async function createDeal(contactId, input) {
const dealName = 'Website Lead - ' + (input.name || input.email || input.phone || 'Unknown');
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/deals', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify({ properties: { dealname: dealName, dealstage: 'appointmentscheduled', pipeline: 'default' }, associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }] }] }) });
if (!res.ok) throw new Error('deal ' + res.status);
const data = await res.json();
return data.id;
}

async function createTask(contactId, input) {
const due = Date.now() + 24 * 60 * 60 * 1000;
const subject = 'Follow up with ' + (input.name || input.email || input.phone || 'new lead');
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/tasks', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify({ properties: { hs_task_subject: subject, hs_task_body: input.message || 'New website contact form submission.', hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_timestamp: due }, associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }] }) });
if (!res.ok) throw new Error('task ' + res.status);
const data = await res.json();
return data.id;
}

const EMAIL_FOOTER = [
'Methodly: Helping you recover missed leads and book more jobs automatically.',
'',
'You are receiving this email because you expressed interest in lead recovery, customer follow-up, business automation, or related services.',
'',
'15300 N 90th St, Scottsdale, AZ 85260 | Manage Preferences | Unsubscribe | https://methodly.me/privacy | https://methodly.me | results@methodly.me',
'',
'\u00A9 2026 Methodly. All rights reserved.'
].join('\n');

const SMS_TEMPLATE = 'Hi! Thanks for reaching out to Methodly.\n\nWe help you recover missed leads and book more jobs automatically.\n\nWe will follow up shortly. You can also book here:\nhttps://meetings.hubspot.com/methodly';

async function sendEmail(input) {
const name = input.name || 'there';
const text = 'Hi ' + name + ',\n\nThanks for reaching out to Methodly. We received your message and will follow up shortly.\n\nWant to grab time now? Book a free evaluation here: ' + BOOKING_URL + '\n\n' + EMAIL_FOOTER;
const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Methodly <' + FROM_EMAIL + '>', to: [input.email], reply_to: SUPPORT_EMAIL, subject: 'Thanks for contacting Methodly', text: text }) });
if (!res.ok) throw new Error('resend ' + res.status);
return true;
}

async function sendSms(toNumber) {
const params = new URLSearchParams();
params.append('To', toNumber);
params.append('From', TWILIO_PHONE_NUMBER);
params.append('Body', SMS_TEMPLATE);
const auth = Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json', { method: 'POST', headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() });
if (!res.ok) throw new Error('twilio ' + res.status);
return true;
}

function validate(data) {
const errors = [];
if (!data || typeof data !== 'object') { errors.push('Invalid payload'); return errors; }
const hasEmail = data.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email);
const hasPhone = data.phone && String(data.phone).replace(/[^0-9]/g, '').length >= 10;
if (!data.name || !data.name.trim()) errors.push('Name is required');
if (!hasEmail && !hasPhone) errors.push('A valid email or phone is required');
return errors;
}

exports.handler = async function (event) {
if (event.httpMethod !== 'POST') {
return json(405, { ok: false, error: 'Method not allowed' });
}

let data;
try {
data = JSON.parse(event.body || '{}');
} catch (e) {
return json(400, { ok: false, error: 'Invalid JSON' });
}

const errors = validate(data);
if (errors.length) {
return json(400, { ok: false, error: errors.join('. ') });
}

const input = {
name: (data.name || '').trim(),
email: (data.email || '').trim(),
phone: (data.phone || '').trim(),
company: (data.company || '').trim(),
message: (data.message || '').trim(),
contact_pref: (data.contact_pref || '').trim(),
sms_consent: data.sms_consent === true,
email_consent: data.email_consent === true
};

let contactId = null;

// Each downstream call is isolated so one failure never breaks the others
// or the user-facing response.
try {
contactId = await upsertContact(input);
} catch (err) {
logError('upsertContact', err);
}

if (contactId) {
try { await createDeal(contactId, input); } catch (err) { logError('createDeal', err); }
try { await createTask(contactId, input); } catch (err) { logError('createTask', err); }
}

if (input.email && input.email_consent !== false) {
try { await sendEmail(input); } catch (err) { logError('sendEmail', err); }
}

if (input.phone && input.sms_consent) {
try { await sendSms(input.phone); } catch (err) { logError('sendSms', err); }
}

// Always return success to the website so the visitor experience is never
// blocked by a transient backend error. Failures are logged server-side.
return json(200, { ok: true, message: 'Thanks! We received your message and will be in touch shortly.' });
};
