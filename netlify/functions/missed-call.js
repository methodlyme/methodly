// Methodly Missed-Call Webhook - Netlify Function
// Endpoint: /.netlify/functions/missed-call
// Flow: Twilio voice status callback -> validate signature -> HubSpot upsert -> Twilio SMS -> Resend email -> HubSpot note
// No Zapier. Automation lives entirely in this serverless function.
const crypto = require('crypto');
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const METHODLY_BOOKING_URL = process.env.METHODLY_BOOKING_URL || 'https://meetings.hubspot.com/methodly';
const METHODLY_FROM_EMAIL = process.env.METHODLY_FROM_EMAIL || 'results@methodly.me';
const METHODLY_SUPPORT_EMAIL = process.env.METHODLY_SUPPORT_EMAIL || 'results@methodly.me';
const HUBSPOT_BASE = 'https://api.hubapi.com';
const MISSED_STATES = ['no-answer', 'busy', 'failed', 'canceled'];
function hubspotHeaders() {
return { Authorization: 'Bearer ' + HUBSPOT_PRIVATE_APP_TOKEN, 'Content-Type': 'application/json' };
}
function twiml(message) {
const body = message ? '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + message + '</Message></Response>' : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: body };
}
function validateTwilioSignature(event, params) {
const signature = event.headers['x-twilio-signature'] || event.headers['X-Twilio-Signature'];
if (!signature || !TWILIO_AUTH_TOKEN) return false;
const proto = event.headers['x-forwarded-proto'] || 'https';
const host = event.headers['host'];
const url = proto + '://' + host + event.path;
let data = url;
Object.keys(params).sort().forEach(function (key) { data += key + params[key]; });
const expected = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); } catch (e) { return false; }
}
async function findContactByPhone(phone) {
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/contacts/search', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] }], properties: ['id', 'phone', 'email', 'firstname', 'lastname', 'sms_consent'] }) });
const data = await res.json();
return data.results && data.results.length > 0 ? data.results[0] : null;
}
async function upsertContact(phone, existing) {
if (existing) {
await fetch(HUBSPOT_BASE + '/crm/v3/objects/contacts/' + existing.id, { method: 'PATCH', headers: hubspotHeaders(), body: JSON.stringify({ properties: { hs_lead_status: 'NEW', last_missed_call: new Date().toISOString() } }) });
return existing.id;
}
const res = await fetch(HUBSPOT_BASE + '/crm/v3/objects/contacts', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify({ properties: { phone: phone, hs_lead_status: 'NEW', lead_source: 'Missed Call', last_missed_call: new Date().toISOString() } }) });
const data = await res.json();
return data.id;
}
async function logNote(contactId, text) {
await fetch(HUBSPOT_BASE + '/crm/v3/objects/notes', { method: 'POST', headers: hubspotHeaders(), body: JSON.stringify({ properties: { hs_note_body: text, hs_timestamp: Date.now() }, associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }] }) });
}
async function sendSms(to, message) {
const creds = Buffer.from(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN).toString('base64');
const form = new URLSearchParams({ To: to, From: TWILIO_PHONE_NUMBER, Body: message });
const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json', { method: 'POST', headers: { Authorization: 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
return res.ok;
}
async function sendEmail(to) {
const html = '<p>Hi,</p>' + '<p>Sorry we missed your call. At Methodly, we help you recover missed leads and book more jobs automatically.</p>' + '<p>Book a free evaluation here: <a href="' + METHODLY_BOOKING_URL + '">' + METHODLY_BOOKING_URL + '</a></p>' + '<hr>' + '<p style="font-size:12px;color:#666">' + 'Methodly: Helping you recover missed leads and book more jobs automatically.<br><br>' + 'You are receiving this email because you expressed interest in lead recovery, customer follow-up, business automation, or related services.<br><br>' + '15300 N 90th St, Scottsdale, AZ 85260 | ' + '<a href="https://methodly.me/privacy">Manage Preferences</a> | ' + '<a href="https://methodly.me/privacy">Unsubscribe</a> | ' + '<a href="https://methodly.me/privacy">https://methodly.me/privacy</a> | ' + '<a href="https://methodly.me">https://methodly.me</a> | ' + '<a href="mailto:' + METHODLY_SUPPORT_EMAIL + '">' + METHODLY_SUPPORT_EMAIL + '</a><br><br>' + '&copy; 2026 Methodly. All rights reserved.' + '</p>';
const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Methodly <' + METHODLY_FROM_EMAIL + '>', to: [to], subject: 'Sorry we missed your call - book your free evaluation', html: html }) });
return res.ok;
}
const SMS_TEMPLATE = 'Hi! Sorry we missed your call.\n\n' + 'At Methodly, we help you recover missed leads and book more jobs automatically.\n\n' + 'Reply YES for a free evaluation, or book here:\n' + 'https://meetings.hubspot.com/methodly';
exports.handler = async function (event) {
if (event.httpMethod !== 'POST') { return { statusCode: 405, body: 'Method Not Allowed' }; }
const params = Object.fromEntries(new URLSearchParams(event.body || ''));
if (!validateTwilioSignature(event, params)) {
console.error('[missed-call] Invalid Twilio signature - rejecting request');
return { statusCode: 403, body: 'Forbidden' };
}
const from = params.From || '';
const to = params.To || '';
const callStatus = (params.CallStatus || '').toLowerCase();
console.log('[missed-call] From:', from, '| To:', to, '| Status:', callStatus);
if (!MISSED_STATES.includes(callStatus)) { console.log('[missed-call] Call answered/in-progress - no follow-up'); return twiml(); }
if (!from) { console.log('[missed-call] No caller number - nothing to do'); return twiml(); }
try {
const existing = await findContactByPhone(from);
const contactId = await upsertContact(from, existing);
let smsOk = false;
try { smsOk = await sendSms(from, SMS_TEMPLATE); } catch (e) { console.error('[missed-call] SMS error:', e.message); }
let emailOk = false;
const email = existing && existing.properties ? existing.properties.email : null;
if (email) { try { emailOk = await sendEmail(email); } catch (e) { console.error('[missed-call] Email error:', e.message); } }
if (contactId) { await logNote(contactId, '[Missed Call] From: ' + from + ' to ' + to + ' | Status: ' + callStatus + ' | SMS sent: ' + smsOk + ' | Email sent: ' + (email ? emailOk : 'no email on file') + ' | Booking: ' + METHODLY_BOOKING_URL); }
} catch (err) {
console.error('[missed-call] Processing error:', err.message);
}
return twiml();
};
