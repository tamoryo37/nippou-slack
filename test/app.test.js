'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('app exports a deployable configuration-pending Express handler', async () => {
  const required = [
    'SLACK_SIGNING_SECRET',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'SLACK_STATE_SECRET',
  ];
  for (const name of required) process.env[name] = '';

  const handler = require('../app');
  assert.equal(typeof handler, 'function');

  const healthLayer = handler.router.stack.find((layer) => layer.route?.path === '/healthz');
  assert.ok(healthLayer, 'health route must be registered');

  const response = {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  await healthLayer.route.stack[0].handle({}, response);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = response.body;
  assert.deepEqual(body, {
    ok: false,
    status: 'configuration_required',
    missing: required,
  });
  assert.doesNotMatch(JSON.stringify(body), /sk-ant|xox[bp]-/);
});

test('configured app exports the Slack Express handler without starting a listener', () => {
  const root = path.join(__dirname, '..');
  const result = spawnSync(
    process.execPath,
    ['-e', "const handler = require('./app'); process.stdout.write(typeof handler);"],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        SLACK_SIGNING_SECRET: 'test-signing-secret',
        SLACK_CLIENT_ID: '123.456',
        SLACK_CLIENT_SECRET: 'test-client-secret',
        SLACK_STATE_SECRET: '0123456789abcdef0123456789abcdef',
        APP_URL: 'https://nippou-slack.example.com',
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'function');
});
