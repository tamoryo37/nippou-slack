'use strict';

async function respondEphemeral(respond, text) {
  if (typeof respond !== 'function') {
    throw new TypeError('Slack command responder is required');
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('Slack command response text is required');
  }

  return respond({ response_type: 'ephemeral', text });
}

module.exports = { respondEphemeral };
