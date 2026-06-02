// netlify/functions/contact.js
// Methodly website contact form handler. Single source of truth for all
// website form submissions. No external middleware. All secrets stay server-side in
// Netlify environment variables. The site always receives a success
// response even if a downstream service (HubSpot/Twilio/Resend) fails.

const crypto = require('crypto');

const HUBSPOT_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const LINK_SIGNING_SECRET = process.env.LINK_SIGNING_SECRET;
const BOOKING_URL = process.env.METHODLY_BOOKING_URL || 'https://meetings.hubspot.com/methodly';
const FROM_EMAIL = process.env.METHODLY_FROM_EMAIL || 'results@methodly.me';
const SUPPORT_EMAIL = process.env.METHODLY_SUPPORT_EMAIL || 'results@methodly.me';
const SITE_URL = process.env.METHODLY_SITE_URL || 'https://methodly.me';
const MAILING_ADDRESS = '15300 N 90th St, Scottsdale, AZ 85260';
const HUBSPOT_BASE = 'https://api.hubapi.com';

function hubspotHeaders() {
  return { 'Authorization': 'Bearer ' + HUBSPOT_TOKEN, 'Content-Type': 'application/json' };
}

function json(statusCode, body) {
  return { statusCode: statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function logError(stage, err) {
  console.error('[contact] ' + stage + ': ' + (err && err.message ? err.message : String(err)));
}

function signToken(payloadObj) {
  const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sig = crypto.createHmac('sha256', LINK_SIGNING_SECRET).update(body).digest('hex');
  return body + '.' + sig;
}

function preferenceUrls(email) {
  if (!LINK_SIGNING_SECRET || !email) return null;
  const t = encodeURIComponent(signToken({ email: email }));
  return { manage: SITE_URL + '/.netlify/functions/manage-preferences?token=' + t, unsubscribe: SITE_URL + '/.netlify/functions/unsubscribe?token=' + t };
}

async function findContact(email, phone) {
  const body = { filterGroups: [], properties: ['email', 'phone', 'firstname'], limit: 1 };
  if (email) body.filterGroups.push({ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] });
  if (phone) body.filterGroups.push({ filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }] });
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
      const data = await res.json();
      return data.id;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmailHtml(name, urls) {
  const greeting = name ? 'Hi ' + escapeHtml(name) + ',' : 'Hi there,';
  const prefsLine = urls ? '<a href="' + urls.manage + '" style="color:#0f172a;text-decoration:underline;">Manage Preferences</a>&nbsp;&middot;&nbsp;<a href="' + urls.unsubscribe + '" style="color:#0f172a;text-decoration:underline;">Unsubscribe</a>' : 'To manage your preferences or unsubscribe, email <a href="mailto:' + SUPPORT_EMAIL + '" style="color:#0f172a;">' + SUPPORT_EMAIL + '</a>.';
  return ['<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">', '<meta name="viewport" content="width=device-width, initial-scale=1">', '<title>Thanks for contacting Methodly</title></head>', '<body style="margin:0;padding:0;background:#f1f5f9;">', '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 0;">', '<tr><td align="center">', '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">', '<tr><td style="background:#0f172a;padding:28px 32px;text-align:center;">', '<span style="color:#ffffff;font-size:24px;font-weight:700;letter-spacing:0.5px;">Method<span style="color:#f5b301;">ly</span></span>', '<div style="color:#94a3b8;font-size:11px;letter-spacing:2px;margin-top:6px;">SYSTEMS &middot; AUTOMATION &middot; RESULTS</div>', '</td></tr>', '<tr><td style="padding:32px;color:#0f172a;font-size:16px;line-height:1.6;">', '<p style="margin:0 0 16px;font-size:18px;font-weight:600;">' + greeting + '</p>', '<p style="margin:0 0 16px;">Thanks for reaching out to Methodly. We received your message and will follow up shortly.</p>', '<p style="margin:0 0 24px;">We help you recover lost revenue by following up with leads quickly and professionally, so you can focus on the work only you can do.</p>', '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;"><tr><td style="border-radius:8px;background:#f5b301;">', '<a href="' + BOOKING_URL + '" style="display:inline-block;padding:14px 28px;color:#0f172a;font-weight:700;font-size:16px;text-decoration:none;">Book a free evaluation</a>', '</td></tr></table>', '<p style="margin:0;color:#475569;font-size:14px;">Questions? Email us at <a href="mailto:' + SUPPORT_EMAIL + '" style="color:#0f172a;">' + SUPPORT_EMAIL + '</a>.</p>', '</td></tr>', '<tr><td style="padding:24px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#64748b;font-size:12px;line-height:1.6;text-align:center;">', '<p style="margin:0 0 8px;">Methodly &middot; ' + MAILING_ADDRESS + '</p>', '<p style="margin:0 0 8px;">' + prefsLine + '</p>', '<p style="margin:0 0 8px;"><a href="' + SITE_URL + '/privacy" style="color:#64748b;text-decoration:underline;">Privacy Policy</a>&nbsp;&middot;&nbsp;<a href="' + SITE_URL + '" style="color:#64748b;text-decoration:underline;">methodly.me</a></p>', '<p style="margin:0;">You are receiving this email because you contacted Methodly about lead recovery or related services.</p>', '<p style="margin:8px 0 0;">&copy; 2026 Methodly. All rights reserved.</p>', '</td></tr></table></td></tr></table></body></html>'].join('');
}

function buildEmailText(name, urls) {
  const greeting = name ? 'Hi ' + name + ',' : 'Hi there,';
  const prefs = urls ? ('Manage preferences: ' + urls.manage + '\nUnsubscribe: ' + urls.unsubscribe) : ('To manage preferences or unsubscribe, email ' + SUPPORT_EMAIL + '.');
  return greeting + '\n\nThanks for reaching out to Methodly. We received your message and will follow up shortly.\n\nBook a free evaluation: ' + BOOKING_URL + '\n\nQuestions? Email ' + SUPPORT_EMAIL + '\n\nMethodly - ' + MAILING_ADDRESS + '\n' + prefs + '\n(c) 2026 Methodly. All rights reserved.';
}

async function sendEmail(input) {
  const name = input.name || '';
  const urls = preferenceUrls(input.email);
  const payload = { from: 'Methodly <' + FROM_EMAIL + '>', to: input.email, reply_to: SUPPORT_EMAIL, subject: 'Thanks for contacting Methodly', html: buildEmailHtml(name, urls), text: buildEmailText(name, urls) };
  if (urls) payload.headers = { 'List-Unsubscribe': '<' + urls.unsubscribe + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error('resend ' + res.status);
  return true;
}

const SMS_TEMPLATE = 'Hi! Thanks for reaching out to Methodly. We help you recover missed leads and book more jobs automatically. We will follow up shortly. Reply STOP to opt out.';

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
  const hasEmail = data.email && /.+@.+\..+/.test(data.email);
  const hasPhone = data.phone && String(data.phone).replace(/\D/g, '').length >= 10;
  if (!data.name || !data.name.trim()) errors.push('Name is required');
  if (!hasEmail && !hasPhone) errors.push('A valid email or phone is required');
  return errors;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  let data;
  try { data = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { ok: false, error: 'Invalid JSON' }); }
  const errors = validate(data);
  if (errors.length) return json(400, { ok: false, error: errors.join('. ') });
  const input = { name: (data.name || '').trim(), email: (data.email || '').trim(), phone: (data.phone || '').trim(), company: (data.company || '').trim(), message: (data.message || '').trim(), contact_pref: (data.contact_pref || '').trim(), sms_consent: data.sms_consent === true, email_consent: data.email_consent === true };
  let contactId = null;
  try { contactId = await upsertContact(input); } catch (err) { logError('upsertContact', err); }
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
  return json(200, { ok: true, message: 'Thanks! We received your message and will be in touch shortly.' });
};
