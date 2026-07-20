'use strict';

function normalizeResponse(message) {
  const payload = typeof message === 'string' ? { text: message } : message;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Slack command response is required');
  }
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    throw new TypeError('Slack command response text is required');
  }

  return { ...payload, response_type: 'ephemeral' };
}

async function respondEphemeral(respond, message) {
  if (typeof respond !== 'function') {
    throw new TypeError('Slack command responder is required');
  }

  return respond(normalizeResponse(message));
}

module.exports = { normalizeResponse, respondEphemeral };
