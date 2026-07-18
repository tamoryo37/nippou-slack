'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SlackWebhookError,
  postIncomingWebhook,
  postSlackWebhook,
} = require('../services/slack');

test('postIncomingWebhook posts JSON with an injectable fetch implementation', async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return {
      ok: true,
      status: 200,
      text: async () => 'ok',
    };
  };

  const result = await postIncomingWebhook('https://hooks.slack.test/services/T/B/X', '*日報*', {
    fetchImpl,
  });

  assert.deepEqual(result, { ok: true, status: 200, body: 'ok' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://hooks.slack.test/services/T/B/X');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['Content-Type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    text: '*日報*',
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.equal(postSlackWebhook, postIncomingWebhook);
});

test('postIncomingWebhook reports Slack status and response body without leaking URL', async () => {
  const secretUrl = 'https://hooks.slack.test/services/SECRET';
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => 'invalid_payload',
  });

  await assert.rejects(
    postIncomingWebhook(secretUrl, 'message', { fetchImpl }),
    (error) => {
      assert.ok(error instanceof SlackWebhookError);
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.status, 400);
      assert.equal(error.responseBody, 'invalid_payload');
      assert.match(error.message, /HTTP 400 Bad Request.*invalid_payload/);
      assert.doesNotMatch(error.message, /SECRET/);
      return true;
    }
  );
});

test('postIncomingWebhook wraps transport failures with their cause', async () => {
  const cause = new Error('socket closed');
  await assert.rejects(
    postIncomingWebhook('https://hooks.slack.test/services/T/B/X', 'message', {
      fetchImpl: async () => {
        throw cause;
      },
    }),
    (error) => {
      assert.ok(error instanceof SlackWebhookError);
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.equal(error.cause, cause);
      assert.match(error.message, /socket closed/);
      return true;
    }
  );
});

test('postIncomingWebhook validates URL, text, and fetch implementation', async () => {
  await assert.rejects(postIncomingWebhook('', 'message'), /webhook URL is required/);
  await assert.rejects(
    postIncomingWebhook('file:///tmp/hook', 'message'),
    /valid HTTP\(S\) URL/
  );
  await assert.rejects(
    postIncomingWebhook('https://hooks.slack.test/x', '  ', { fetchImpl: async () => {} }),
    /message text is required/
  );
  await assert.rejects(
    postIncomingWebhook('https://hooks.slack.test/x', 'message', { fetchImpl: 'nope' }),
    /fetch implementation is required/
  );
});
