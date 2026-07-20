'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { respondEphemeral } = require('../services/slack-command-response');

test('respondEphemeral replies through the slash command response URL', async () => {
  const payloads = [];
  const respond = async (payload) => {
    payloads.push(payload);
    return { ok: true };
  };

  const result = await respondEphemeral(respond, '先に `/nippou setup` を実行してください。');

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(payloads, [{
    response_type: 'ephemeral',
    text: '先に `/nippou setup` を実行してください。',
  }]);
});

test('respondEphemeral rejects missing responder or response text', async () => {
  await assert.rejects(respondEphemeral(null, 'message'), /responder is required/);
  await assert.rejects(respondEphemeral(async () => {}, '  '), /response text is required/);
});
