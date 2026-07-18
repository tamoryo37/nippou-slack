'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  getUserData,
  saveUserData,
  getUserSlackToken,
  installationStore,
  __testing,
} = require('../services/store');

const KEY = Buffer.alloc(32, 0x42).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 0x24).toString('base64');

test('encrypted store values use the versioned format and round-trip JSON', () => {
  const value = {
    togglToken: 'sensitive-toggl-token',
    googleAccounts: [{ email: 'person@example.com', tokens: { refresh_token: 'secret' } }],
  };

  const encrypted = __testing.encryptJson(value, 'users', 'U123', KEY);

  assert.match(encrypted, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(encrypted, __testing.encryptJson(value, 'users', 'U123', KEY));
  assert.deepEqual(__testing.decryptJson(encrypted, 'users', 'U123', KEY), value);
});

test('encrypted store values do not contain plaintext secrets', () => {
  const secret = 'sk-test-this-must-never-be-stored-in-plaintext';
  const encrypted = __testing.encryptJson({ token: secret }, 'slack-user-tokens', 'U123', KEY);

  assert.equal(encrypted.includes(secret), false);
  assert.equal(encrypted.includes('token'), false);
});

test('AES-GCM rejects the wrong key and AAD', () => {
  const encrypted = __testing.encryptJson({ token: 'secret' }, 'users', 'U123', KEY);

  assert.throws(
    () => __testing.decryptJson(encrypted, 'users', 'U123', OTHER_KEY),
    /could not be decrypted/
  );
  assert.throws(
    () => __testing.decryptJson(encrypted, 'users', 'U999', KEY),
    /could not be decrypted/
  );
  assert.throws(
    () => __testing.decryptJson(encrypted, 'other-namespace', 'U123', KEY),
    /could not be decrypted/
  );
});

test('encryption key must be base64 for exactly 32 bytes', () => {
  assert.throws(() => __testing.parseEncryptionKey(), /NIPPOU_ENCRYPTION_KEY/);
  assert.throws(
    () => __testing.parseEncryptionKey(Buffer.alloc(31).toString('base64')),
    /exactly 32 bytes/
  );
  assert.throws(() => __testing.parseEncryptionKey('not base64!'), /valid base64/);
  assert.equal(__testing.parseEncryptionKey(KEY).length, 32);
});

test('Vercel storage fails clearly when DATABASE_URL is missing', () => {
  const previousVercel = process.env.VERCEL;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    process.env.VERCEL = '1';
    delete process.env.DATABASE_URL;
    assert.throws(
      () => __testing.resolveStorageBackend(),
      /DATABASE_URL is required for persistent storage on Vercel/
    );
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});

test('Postgres storage requires the encryption key before first use', () => {
  const previousVercel = process.env.VERCEL;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousEncryptionKey = process.env.NIPPOU_ENCRYPTION_KEY;
  try {
    delete process.env.VERCEL;
    process.env.DATABASE_URL = 'postgresql://example.invalid/database';
    delete process.env.NIPPOU_ENCRYPTION_KEY;
    assert.throws(() => __testing.resolveStorageBackend(), /NIPPOU_ENCRYPTION_KEY is required/);

    process.env.NIPPOU_ENCRYPTION_KEY = KEY;
    assert.equal(__testing.resolveStorageBackend(), 'postgres');
  } finally {
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEncryptionKey === undefined) delete process.env.NIPPOU_ENCRYPTION_KEY;
    else process.env.NIPPOU_ENCRYPTION_KEY = previousEncryptionKey;
  }
});

test('user store keys isolate identical user IDs across Slack workspaces', () => {
  assert.equal(__testing.userStoreKey('U123', 'T111'), 'T111-U123');
  assert.equal(__testing.userStoreKey('U123', 'T222'), 'T222-U123');
  assert.equal(__testing.userStoreKey('U123'), 'U123');
  assert.throws(() => __testing.userStoreKey('U123', '../team'), /Invalid Slack team ID/);
});

test('filesystem fallback keeps user data and Slack tokens isolated by workspace', async () => {
  const suffix = randomUUID().replaceAll('-', '').toUpperCase();
  const userId = `U${suffix}`;
  const firstTeamId = `T${suffix}A`;
  const secondTeamId = `T${suffix}B`;
  const storeDir = path.join(__dirname, '..', 'store');
  const cleanupFiles = [
    path.join(storeDir, 'users', `${firstTeamId}-${userId}.json`),
    path.join(storeDir, 'users', `${secondTeamId}-${userId}.json`),
    path.join(storeDir, 'installations', `team-${firstTeamId}.json`),
    path.join(storeDir, 'installations', `user-${firstTeamId}-${userId}.json`),
  ];
  const previousVercel = process.env.VERCEL;
  const previousDatabaseUrl = process.env.DATABASE_URL;

  try {
    delete process.env.VERCEL;
    delete process.env.DATABASE_URL;

    await saveUserData(userId, { togglToken: 'first-token' }, firstTeamId);
    await saveUserData(userId, { togglToken: 'second-token' }, secondTeamId);
    assert.deepEqual(await getUserData(userId, firstTeamId), { togglToken: 'first-token' });
    assert.deepEqual(await getUserData(userId, secondTeamId), { togglToken: 'second-token' });
    assert.deepEqual(await getUserData(userId), {});

    const installation = {
      isEnterpriseInstall: false,
      team: { id: firstTeamId },
      user: { id: userId, token: 'xoxp-secret', scopes: ['chat:write'] },
      bot: { token: 'xoxb-secret' },
    };
    await installationStore.storeInstallation(installation);
    assert.equal(await getUserSlackToken(userId, firstTeamId), 'xoxp-secret');
    assert.equal(await getUserSlackToken(userId, secondTeamId), null);
    assert.deepEqual(
      await installationStore.fetchInstallation({ teamId: firstTeamId }),
      installation
    );
    await installationStore.deleteInstallation({ teamId: firstTeamId });
    assert.equal(await getUserSlackToken(userId, firstTeamId), null);
  } finally {
    await Promise.all(cleanupFiles.map((file) => fs.rm(file, { force: true })));
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
});
