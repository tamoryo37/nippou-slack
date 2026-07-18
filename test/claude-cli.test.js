'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const {
  ClaudeCliError,
  buildChildEnv,
  buildClaudeCliArgs,
  parseClaudeCliOutput,
  resolveClaudeCliPath,
  runClaudeCliStructured,
} = require('../services/claude-cli');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};

test('buildClaudeCliArgs disables tools and persistence without putting prompts in argv', () => {
  const args = buildClaudeCliArgs({
    schema: SCHEMA,
    model: 'sonnet',
    systemPromptFile: '/private/tmp/system-prompt.txt',
  });

  assert.ok(args.includes('--safe-mode'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--no-chrome'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--prompt-suggestions') + 1], 'false');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], '/private/tmp/system-prompt.txt');
  assert.doesNotMatch(args.join(' '), /private instruction|source data/);
});

test('parseClaudeCliOutput returns structured output and rejects unsafe envelopes', () => {
  assert.deepEqual(parseClaudeCliOutput(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: { ok: true },
  })), { ok: true });

  assert.throws(
    () => parseClaudeCliOutput('not-json'),
    (error) => error instanceof ClaudeCliError && error.code === 'INVALID_JSON',
  );
  assert.throws(
    () => parseClaudeCliOutput(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"ok":true}',
    })),
    (error) => error.code === 'MISSING_STRUCTURED_OUTPUT',
  );
  assert.throws(
    () => parseClaudeCliOutput(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { ok: true },
      permission_denials: ['tool'],
    })),
    (error) => error.code === 'PERMISSION_DENIED',
  );
  assert.throws(
    () => parseClaudeCliOutput(JSON.stringify({
      is_error: true,
      result: 'failed with sk-ant-secret-value',
    })),
    (error) => {
      assert.equal(error.code, 'CLAUDE_ERROR');
      assert.doesNotMatch(error.message, /sk-ant-secret-value/);
      return true;
    },
  );
});

test('runClaudeCliStructured uses stdin and a private temporary system prompt', async () => {
  let captured;
  let promptPath;
  let stdinText = '';

  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        stdinText += chunk.toString('utf8');
        callback();
      },
    });
    child.kill = () => true;
    captured = { command, args, options };
    promptPath = args[args.indexOf('--system-prompt-file') + 1];

    process.nextTick(() => {
      assert.equal(fs.statSync(promptPath).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(promptPath, 'utf8'), 'private instruction');
      child.stdout.end(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        structured_output: { ok: true },
      }));
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await runClaudeCliStructured({
    systemPrompt: 'private instruction',
    userMessage: 'source data',
    schema: SCHEMA,
    model: 'sonnet',
    command: '/fake/claude',
    env: { ANTHROPIC_API_KEY: 'must-not-be-inherited' },
    spawnImpl,
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(captured.command, '/fake/claude');
  assert.equal(captured.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(stdinText, 'source data');
  assert.equal(fs.existsSync(promptPath), false);
  assert.equal(fs.existsSync(captured.options.cwd), false);
});

test('runClaudeCliStructured preserves Japanese text split across byte chunks', async () => {
  const output = Buffer.from(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    structured_output: { text: '日報を作成' },
  }));
  const japaneseStart = output.indexOf(Buffer.from('日'));

  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.kill = () => true;
    process.nextTick(() => {
      child.stdout.write(output.subarray(0, japaneseStart + 1));
      child.stdout.end(output.subarray(japaneseStart + 1));
      child.emit('close', 0, null);
    });
    return child;
  };

  const result = await runClaudeCliStructured({
    systemPrompt: 'system',
    userMessage: 'input',
    schema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    model: 'sonnet',
    command: '/fake/claude',
    spawnImpl,
  });

  assert.deepEqual(result, { text: '日報を作成' });
});

test('resolveClaudeCliPath honors an explicit command', () => {
  assert.equal(resolveClaudeCliPath({ command: '/custom/claude' }), '/custom/claude');
});

test('buildChildEnv does not inherit application secrets', () => {
  const env = buildChildEnv({
    HOME: '/Users/test',
    PATH: '/usr/bin',
    ANTHROPIC_API_KEY: 'secret',
    SLACK_WEBHOOK_URL: 'secret',
    TOGGL_API_TOKEN: 'secret',
  });

  assert.equal(env.HOME, '/Users/test');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SLACK_WEBHOOK_URL, undefined);
  assert.equal(env.TOGGL_API_TOKEN, undefined);
});
