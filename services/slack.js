'use strict';

class SlackWebhookError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'SlackWebhookError';
    if (details.cause !== undefined) this.cause = details.cause;
    if (details.code !== undefined) this.code = details.code;
    if (details.status !== undefined) this.status = details.status;
    if (details.responseBody !== undefined) this.responseBody = details.responseBody;
  }
}

function validateWebhookUrl(webhookUrl) {
  if (typeof webhookUrl !== 'string' || !webhookUrl.trim()) {
    throw new TypeError('Slack webhook URL is required');
  }

  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch (_) {
    throw new TypeError('Slack webhook URL must be a valid HTTP(S) URL');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Slack webhook URL must be a valid HTTP(S) URL');
  }
  return parsed.toString();
}

async function readResponseBody(response) {
  if (!response || typeof response.text !== 'function') return '';
  try {
    return await response.text();
  } catch (_) {
    return '';
  }
}

function summarizeBody(body) {
  const normalized = String(body || '').replace(/\s+/g, ' ').trim();
  return normalized.length > 300 ? `${normalized.slice(0, 300)}...` : normalized;
}

/**
 * Post plain Slack mrkdwn through an Incoming Webhook.
 * fetchImpl is injectable so callers/tests do not need to replace globals.
 */
async function postIncomingWebhook(webhookUrl, text, options = {}) {
  const url = validateWebhookUrl(webhookUrl);
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('Slack message text is required');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new SlackWebhookError(
      `Slack incoming webhook request failed: ${cause && cause.message ? cause.message : String(cause)}`,
      { cause, code: 'NETWORK_ERROR' }
    );
  }

  if (!response || typeof response.ok !== 'boolean') {
    throw new SlackWebhookError('Slack incoming webhook returned an invalid response', {
      code: 'INVALID_RESPONSE',
    });
  }

  const responseBody = await readResponseBody(response);
  if (!response.ok) {
    const status = Number.isFinite(response.status) ? response.status : 0;
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    const bodySummary = summarizeBody(responseBody);
    const bodySuffix = bodySummary ? `: ${bodySummary}` : '';
    throw new SlackWebhookError(
      `Slack incoming webhook rejected the message (HTTP ${status}${statusText})${bodySuffix}`,
      {
        code: 'HTTP_ERROR',
        status,
        responseBody,
      }
    );
  }

  return {
    ok: true,
    status: Number.isFinite(response.status) ? response.status : 200,
    body: responseBody,
  };
}

module.exports = {
  SlackWebhookError,
  postIncomingWebhook,
  postSlackWebhook: postIncomingWebhook,
  postToIncomingWebhook: postIncomingWebhook,
};
