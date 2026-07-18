'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const fsp = fs.promises;
const DEFAULT_POSTS_DIR = path.join(__dirname, '..', 'store', 'posts');
const LEDGER_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[-_.:][A-Za-z0-9][A-Za-z0-9._:-]*)?$/;

function normalizeLedgerKey(value) {
  if (typeof value !== 'string') throw new TypeError('post ledger key must be a string');
  const key = value.trim();
  if (!key || key.length > 180 || !LEDGER_KEY_PATTERN.test(key)) {
    throw new TypeError(
      'post ledger key must start with an ISO date and contain only letters, numbers, dot, colon, underscore, or hyphen'
    );
  }

  const date = key.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new TypeError('post ledger key must start with a valid ISO date');
  }
  return key;
}

function assertMetadata(metadata) {
  if (metadata === undefined) return {};
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('post ledger metadata must be an object');
  }
  return metadata;
}

function serializeRecord(record) {
  try {
    return `${JSON.stringify(record, null, 2)}\n`;
  } catch (cause) {
    const error = new TypeError('post ledger metadata must be JSON-serializable');
    error.cause = cause;
    throw error;
  }
}

function timestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('post ledger clock returned an invalid date');
  return date.toISOString();
}

async function writeTempFile(postsDir, fileName, contents) {
  await fsp.mkdir(postsDir, { recursive: true });
  const tempPath = path.join(postsDir, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(tempPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    return tempPath;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function removeTempFile(tempPath) {
  await fsp.unlink(tempPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

function createPostLedger(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('post ledger options must be an object');
  }

  const postsDir = options.postsDir || DEFAULT_POSTS_DIR;
  const now = options.now || (() => new Date());
  if (typeof postsDir !== 'string' || !postsDir) {
    throw new TypeError('postsDir must be a non-empty string');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  function recordPath(key) {
    return path.join(postsDir, `${normalizeLedgerKey(key)}.json`);
  }

  async function get(key) {
    const file = recordPath(key);
    let contents;
    try {
      contents = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    try {
      return JSON.parse(contents);
    } catch (cause) {
      const error = new Error(`Invalid post ledger record: ${path.basename(file)}`);
      error.cause = cause;
      throw error;
    }
  }

  async function has(key) {
    return (await get(key)) !== null;
  }

  /**
   * Atomically reserve a report/webhook key. A fully-written temp file is
   * hard-linked into place, so concurrent processes can never both win.
   */
  async function claim(key, metadata) {
    const normalizedKey = normalizeLedgerKey(key);
    const details = assertMetadata(metadata);
    const fileName = `${normalizedKey}.json`;
    const finalPath = path.join(postsDir, fileName);
    const record = {
      ...details,
      key: normalizedKey,
      date: normalizedKey.slice(0, 10),
      status: 'claimed',
      claimedAt: timestamp(now),
    };
    const tempPath = await writeTempFile(postsDir, fileName, serializeRecord(record));

    try {
      await fsp.link(tempPath, finalPath);
      await removeTempFile(tempPath);
      return true;
    } catch (error) {
      await removeTempFile(tempPath);
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  }

  /** Atomically replace a claimed record with the completed post record. */
  async function markPosted(key, metadata) {
    const normalizedKey = normalizeLedgerKey(key);
    const details = assertMetadata(metadata);
    const existing = await get(normalizedKey);
    if (existing && existing.status === 'posted') return existing;

    const postedAt = timestamp(now);
    const record = {
      ...(existing || {}),
      ...details,
      key: normalizedKey,
      date: normalizedKey.slice(0, 10),
      status: 'posted',
      postedAt,
    };
    const fileName = `${normalizedKey}.json`;
    const finalPath = path.join(postsDir, fileName);
    const tempPath = await writeTempFile(postsDir, fileName, serializeRecord(record));

    try {
      await fsp.rename(tempPath, finalPath);
      return record;
    } catch (error) {
      await removeTempFile(tempPath);
      throw error;
    }
  }

  /** Release a failed claim. Completed records are deliberately retained. */
  async function release(key) {
    const normalizedKey = normalizeLedgerKey(key);
    const record = await get(normalizedKey);
    if (!record || record.status !== 'claimed') return false;

    try {
      await fsp.unlink(recordPath(normalizedKey));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  return {
    claim,
    get,
    has,
    mark: markPosted,
    markPosted,
    release,
    postsDir,
  };
}

const defaultLedger = createPostLedger();

module.exports = {
  DEFAULT_POSTS_DIR,
  createPostLedger,
  normalizeLedgerKey,
  claim: defaultLedger.claim,
  get: defaultLedger.get,
  getPostRecord: defaultLedger.get,
  has: defaultLedger.has,
  hasPosted: defaultLedger.has,
  mark: defaultLedger.mark,
  markPosted: defaultLedger.markPosted,
  release: defaultLedger.release,
  releaseClaim: defaultLedger.release,
};
