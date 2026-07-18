'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fsp = fs.promises;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const ALLOWED_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CLAUDE_CONFIG_DIR',
];

class ClaudeCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ClaudeCliError';
    if (details.code !== undefined) this.code = details.code;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}

function resolveClaudeCliPath(options = {}) {
  if (options.command) return options.command;
  if (process.env.NIPPOU_CLAUDE_CLI_PATH) return process.env.NIPPOU_CLAUDE_CLI_PATH;
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;

  const localBinary = path.join(os.homedir(), '.local', 'bin', 'claude');
  try {
    fs.accessSync(localBinary, fs.constants.X_OK);
    return localBinary;
  } catch (_) {
    return 'claude';
  }
}

function buildClaudeCliArgs({ schema, model, systemPromptFile }) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('Claude CLI JSON schema must be an object');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new TypeError('Claude CLI model must be a non-empty string');
  }
  if (typeof systemPromptFile !== 'string' || !systemPromptFile) {
    throw new TypeError('Claude CLI system prompt file is required');
  }

  return [
    '--print',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--tools', '',
    '--safe-mode',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
    '--prompt-suggestions', 'false',
    '--no-session-persistence',
    '--no-chrome',
    '--model', model.trim(),
    '--system-prompt-file', systemPromptFile,
  ];
}

function sanitizeErrorText(value) {
  return String(value || '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '<redacted-api-key>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function parseClaudeCliOutput(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout || '').trim());
  } catch (cause) {
    throw new ClaudeCliError('Claude CLI returned invalid JSON', {
      code: 'INVALID_JSON',
      cause,
    });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ClaudeCliError('Claude CLI returned an invalid response envelope', {
      code: 'INVALID_RESPONSE',
    });
  }
  if (
    payload.type !== 'result' ||
    payload.subtype !== 'success' ||
    payload.is_error !== false
  ) {
    throw new ClaudeCliError(
      `Claude CLI generation failed${payload.result ? `: ${sanitizeErrorText(payload.result)}` : ''}`,
      { code: 'CLAUDE_ERROR' },
    );
  }

  if (Array.isArray(payload.permission_denials) && payload.permission_denials.length > 0) {
    throw new ClaudeCliError('Claude CLI reported permission denials', {
      code: 'PERMISSION_DENIED',
    });
  }

  const structured = Object.prototype.hasOwnProperty.call(payload, 'structured_output')
    ? payload.structured_output
    : null;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured;
  }

  throw new ClaudeCliError('Claude CLI returned no structured output', {
    code: 'MISSING_STRUCTURED_OUTPUT',
  });
}

function buildChildEnv(overrides = {}) {
  const source = { ...process.env, ...overrides };
  const result = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (typeof source[key] === 'string' && source[key]) result[key] = source[key];
  }
  return result;
}

function parseTimeout(value) {
  const timeout = Number(value || DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeout) || timeout < 5000 || timeout > 600000) {
    throw new TypeError('Claude CLI timeout must be between 5000 and 600000 milliseconds');
  }
  return timeout;
}

async function runClaudeCliStructured(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Claude CLI options must be an object');
  }

  const systemPrompt = String(options.systemPrompt || '');
  const userMessage = String(options.userMessage || '');
  if (!systemPrompt.trim()) throw new TypeError('Claude CLI system prompt is required');
  if (!userMessage.trim()) throw new TypeError('Claude CLI user message is required');
  if (Buffer.byteLength(systemPrompt) > MAX_PROMPT_BYTES) {
    throw new RangeError('Claude CLI system prompt is too large');
  }
  if (Buffer.byteLength(userMessage) > MAX_PROMPT_BYTES) {
    throw new RangeError('Claude CLI user message is too large');
  }

  const timeoutMs = parseTimeout(options.timeoutMs || process.env.CLAUDE_CLI_TIMEOUT_MS);
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nippou-claude-'));
  const systemPromptFile = path.join(tempDir, 'system-prompt.txt');

  try {
    await fsp.chmod(tempDir, 0o700);
    await fsp.writeFile(systemPromptFile, systemPrompt, { encoding: 'utf8', mode: 0o600 });

    const command = resolveClaudeCliPath(options);
    const args = buildClaudeCliArgs({
      schema: options.schema,
      model: options.model || process.env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6',
      systemPromptFile,
    });
    // A local CLI run gets only the environment required for the signed-in
    // Claude account and networking. Slack/Toggl/Google/API secrets are never
    // inherited by the child process.
    const childEnv = buildChildEnv(options.env || {});

    const output = await new Promise((resolve, reject) => {
      const child = (options.spawnImpl || spawn)(command, args, {
        cwd: options.cwd || tempDir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new ClaudeCliError(`Claude CLI timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT',
        }));
        const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
        forceKill.unref();
      }, timeoutMs);
      timer.unref();

      child.on('error', (cause) => {
        finish(new ClaudeCliError(`Claude CLI could not start: ${cause.message}`, {
          code: cause.code || 'SPAWN_ERROR',
          cause,
        }));
      });
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM');
          finish(new ClaudeCliError('Claude CLI output exceeded the safety limit', {
            code: 'OUTPUT_TOO_LARGE',
          }));
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > MAX_ERROR_BYTES) {
          stderr = stderr.slice(-MAX_ERROR_BYTES);
        }
      });
      child.on('close', (code, signal) => {
        if (code !== 0) {
          const detail = sanitizeErrorText(stderr);
          finish(new ClaudeCliError(
            `Claude CLI exited unsuccessfully (${signal || code})${detail ? `: ${detail}` : ''}`,
            { code: 'NON_ZERO_EXIT' },
          ));
          return;
        }
        finish(null, stdout);
      });

      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') finish(error);
      });
      child.stdin.end(userMessage);
    });

    return parseClaudeCliOutput(output);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = {
  ClaudeCliError,
  DEFAULT_TIMEOUT_MS,
  buildChildEnv,
  buildClaudeCliArgs,
  parseClaudeCliOutput,
  resolveClaudeCliPath,
  runClaudeCliStructured,
};
