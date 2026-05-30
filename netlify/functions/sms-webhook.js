// ═══════════════════════════════════════════════════════════════
// Methodly SMS Webhook — Netlify Function
// Handles: inbound SMS (Twilio webhook), STOP opt-out, HELP response
// TCPA/CTIA compliant
// Updated: 2026-05-29
// ═══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parse Twilio's form-encoded body
  const params = Object.fromEntries(new URLSearchParams(event.body));
  const from = params.From || '';
  const body = (params.Body || '').trim().toUpperCase();

  const HUBSPOT_PRIVATE_APP_TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

  // ═══════════════════════════════════════
  //  COMPLIANCE: STOP HANDLING (TCPA Req.)
  //  If user replies STOP (or variations), immediately mark
  //  smsConsent = false in HubSpot and send no further SMS.
  // ═══════════════════════════════════════
  const isStop = /^STOP(ALL|OPT-?OUT)?$/.test(body) || body === 'STOP' || body === 'UNSUBSCRIBE' || body === 'CANCEL' || body === 'END' || body === 'QUIT';

  if (isStop) {
    console.log('[COMPLIANCE] STOP received from:', from);

    // Mark smsConsent = false in HubSpot CRM
    try {
      const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + HUBSPOT_PRIVATE_APP_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          filterGroups: [{
            filters: [{
              propertyName: 'phone',
              operator: 'EQ',
              value: from
            }]
          }],
          properties: ['id', 'phone', 'sms_consent']
        })
      });
      const searchData = await searchRes.json();

      if (searchData.results && searchData.results.length > 0) {
        const contactId = searchData.results[0].id;

        // Update contact: smsConsent = false, do_not_text = true
        await fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + contactId, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer ' + HUBSPOT_PRIVATE_APP_TOKEN,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: {
              sms_consent: 'false',
              do_not_text: 'true',
              sms_opt_out_timestamp: new Date().toISOString(),
              sms_opt_out_source: 'STOP_reply'
            }
          })
        });
        console.log('[COMPLIANCE] STOP: Updated contact', contactId, '— sms_consent=false');
      } else {
        console.log('[COMPLIANCE] STOP: No HubSpot contact found for', from, '— logging externally');
        // TODO: Log to external compliance store if contact not in CRM
      }
    } catch (err) {
      console.error('[COMPLIANCE] STOP handling error:', err.message);
    }

    // Twilio handles the STOP acknowledgment automatically per carrier requirements.
    // Return empty TwiML — do NOT send any additional SMS.
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
    };
  }

  // ═══════════════════════════════════════
  //  COMPLIANCE: HELP HANDLING
  //  Required CTIA response to HELP keyword
  // ═══════════════════════════════════════
  const isHelp = body === 'HELP' || body === 'INFO';

  if (isHelp) {
    console.log('[COMPLIANCE] HELP received from:', from);

    const helpMessage = 'Methodly: You can reach us at results@methodly.me. Reply STOP to opt out. Msg/data rates may apply.';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/xml' },
      body: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + helpMessage + '</Message></Response>'
    };
  }

  // ═══════════════════════════════════════
  //  INBOUND MESSAGE HANDLING
  //  Log to HubSpot, notify team
  // ═══════════════════════════════════════
  console.log('[SMS] Inbound message from:', from, '| Body:', params.Body);

  try {
    // Search for existing contact by phone
    const searchRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + HUBSPOT_PRIVATE_APP_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filterGroups: [{
          filters: [{
            propertyName: 'phone',
            operator: 'EQ',
            value: from
          }]
        }],
        properties: ['id', 'phone', 'email', 'firstname', 'lastname', 'sms_consent']
      })
    });
    const searchData = await searchRes.json();

    if (searchData.results && searchData.results.length > 0) {
      const contactId = searchData.results[0].id;
      const smsConsent = searchData.results[0].properties?.sms_consent;

      // COMPLIANCE: Only log/respond if smsConsent is not explicitly false
      if (smsConsent === 'false') {
        console.log('[COMPLIANCE] Inbound SMS from opted-out contact:', contactId, '— not responding via SMS');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/xml' },
          body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
        };
      }

      // Log inbound message as a note on the contact
      await fetch('https://api.hubapi.com/crm/v3/objects/notes', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + HUBSPOT_PRIVATE_APP_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            hs_note_body: '[Inbound SMS] From: ' + from + '\nMessage: ' + params.Body,
            hs_timestamp: Date.now()
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
          }]
        })
      });
    } else {
      console.log('[SMS] No contact found for', from, '— creating new contact');
      await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + HUBSPOT_PRIVATE_APP_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          properties: {
            phone: from,
            hs_lead_status: 'NEW',
            sms_consent: 'false', // No consent confirmed — do not send outbound SMS
            lead_source: 'Inbound SMS'
          }
        })
      });
    }
  } catch (err) {
    console.error('[SMS] HubSpot error:', err.message);
  }

  // Return empty response — do not auto-reply without confirmed SMS consent
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
  };
};
