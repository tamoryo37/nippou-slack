'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createPostLedger,
  normalizeLedgerKey,
} = require('../services/post-ledger');

async function withTempLedger(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nippou-ledger-'));
  const postsDir = path.join(root, 'store', 'posts');
  try {
    await run(createPostLedger({
      postsDir,
      now: () => new Date('2026-07-13T09:00:00.000Z'),
    }), postsDir);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('only one concurrent claim wins for the same date and webhook hash', async () => {
  await withTempLedger(async (ledger, postsDir) => {
    const key = '2026-07-13-webhookabc123';
    const results = await Promise.all([
      ledger.claim(key, { source: 'cli-a' }),
      ledger.claim(key, { source: 'cli-b' }),
    ]);

    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await ledger.has(key), true);
    const record = await ledger.get(key);
    assert.equal(record.key, key);
    assert.equal(record.date, '2026-07-13');
    assert.equal(record.status, 'claimed');
    assert.equal(record.claimedAt, '2026-07-13T09:00:00.000Z');

    const files = await fs.readdir(postsDir);
    assert.deepEqual(files, [`${key}.json`]);
  });
});

test('markPosted atomically replaces a claim and remains idempotent', async () => {
  await withTempLedger(async (ledger) => {
    const key = '2026-07-13-a1b2c3';
    assert.equal(await ledger.claim(key, { attempt: 1 }), true);

    const marked = await ledger.markPosted(key, { slackResponse: 'ok' });
    assert.equal(marked.status, 'posted');
    assert.equal(marked.attempt, 1);
    assert.equal(marked.slackResponse, 'ok');
    assert.equal(marked.postedAt, '2026-07-13T09:00:00.000Z');
    assert.deepEqual(await ledger.get(key), marked);

    const markedAgain = await ledger.mark(key, { slackResponse: 'changed' });
    assert.deepEqual(markedAgain, marked);
  });
});

test('release removes failed claims but never completed records', async () => {
  await withTempLedger(async (ledger) => {
    const failedKey = '2026-07-13-failed';
    assert.equal(await ledger.claim(failedKey), true);
    assert.equal(await ledger.release(failedKey), true);
    assert.equal(await ledger.release(failedKey), false);
    assert.equal(await ledger.get(failedKey), null);

    const postedKey = '2026-07-13-posted';
    assert.equal(await ledger.claim(postedKey), true);
    await ledger.markPosted(postedKey);
    assert.equal(await ledger.release(postedKey), false);
    assert.equal((await ledger.get(postedKey)).status, 'posted');
  });
});

test('ledger key validation prevents traversal and invalid dates', () => {
  assert.equal(normalizeLedgerKey(' 2026-07-13-abc_123 '), '2026-07-13-abc_123');
  assert.throws(() => normalizeLedgerKey('../2026-07-13'), /must start with an ISO date/);
  assert.throws(() => normalizeLedgerKey('2026-02-30-abc'), /valid ISO date/);
  assert.throws(() => normalizeLedgerKey('2026-07-13/webhook'), /must start with an ISO date/);
});
