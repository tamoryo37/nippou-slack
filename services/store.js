'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const STORE_DIR = path.join(__dirname, '..', 'store');
const USERS_DIR = path.join(STORE_DIR, 'users');
const INSTALLATIONS_DIR = path.join(STORE_DIR, 'installations');

const USER_NAMESPACE = 'users';
const INSTALLATION_NAMESPACE = 'slack-installations';
const USER_TOKEN_NAMESPACE = 'slack-user-tokens';

let localDirectoriesPromise;
let sqlClient;
let sqlClientUrl;
let schemaPromise;
let schemaUrl;

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function userStoreKey(slackUserId, slackTeamId) {
  const userId = safeId(slackUserId, 'Slack user ID');
  if (slackTeamId === undefined || slackTeamId === null || slackTeamId === '') {
    return userId;
  }
  return `${safeId(slackTeamId, 'Slack team ID')}-${userId}`;
}

function resolveStorageBackend() {
  if (typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.trim()) {
    parseEncryptionKey();
    return 'postgres';
  }

  if (process.env.VERCEL) {
    throw new Error(
      'DATABASE_URL is required for persistent storage on Vercel. ' +
      'Connect a Neon/Postgres database to this project before using the app.'
    );
  }

  return 'filesystem';
}

function parseEncryptionKey(encodedKey = process.env.NIPPOU_ENCRYPTION_KEY) {
  if (typeof encodedKey !== 'string' || !encodedKey.trim()) {
    throw new Error(
      'NIPPOU_ENCRYPTION_KEY is required when DATABASE_URL is configured. ' +
      'Set it to a base64-encoded 32-byte key.'
    );
  }

  const value = encodedKey.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('NIPPOU_ENCRYPTION_KEY must be valid base64 for exactly 32 bytes.');
  }

  const key = Buffer.from(value, 'base64');
  const normalizedInput = value.replace(/=+$/, '');
  const normalizedDecoded = key.toString('base64').replace(/=+$/, '');
  if (key.length !== 32 || normalizedInput !== normalizedDecoded) {
    throw new Error('NIPPOU_ENCRYPTION_KEY must be valid base64 for exactly 32 bytes.');
  }

  return key;
}

function buildAad(namespace, storeKey) {
  return Buffer.from(`${namespace}:${storeKey}`, 'utf8');
}

function encryptJson(value, namespace, storeKey, encodedKey = process.env.NIPPOU_ENCRYPTION_KEY) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Stored value must be JSON serializable');
  }

  const key = parseEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(buildAad(namespace, storeKey));
  const ciphertext = Buffer.concat([
    cipher.update(serialized, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function decodeCipherPart(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Stored encrypted ${label} is invalid`);
  }
  return Buffer.from(value, 'base64url');
}

function decryptJson(encryptedValue, namespace, storeKey, encodedKey = process.env.NIPPOU_ENCRYPTION_KEY) {
  if (typeof encryptedValue !== 'string') {
    throw new Error('Stored encrypted value is invalid');
  }

  const parts = encryptedValue.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Stored encrypted value has an unsupported format');
  }

  const iv = decodeCipherPart(parts[1], 'IV');
  const authTag = decodeCipherPart(parts[2], 'authentication tag');
  const ciphertext = decodeCipherPart(parts[3], 'ciphertext');
  if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
    throw new Error('Stored encrypted value is invalid');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', parseEncryptionKey(encodedKey), iv);
    decipher.setAAD(buildAad(namespace, storeKey));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(plaintext);
  } catch (error) {
    throw new Error(
      'Stored value could not be decrypted. Check NIPPOU_ENCRYPTION_KEY and data integrity.',
      { cause: error }
    );
  }
}

async function ensureLocalDirectories() {
  if (!localDirectoriesPromise) {
    localDirectoriesPromise = (async () => {
      for (const dir of [STORE_DIR, USERS_DIR, INSTALLATIONS_DIR]) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.chmod(dir, 0o700);
      }
    })().catch((error) => {
      localDirectoriesPromise = undefined;
      throw error;
    });
  }
  await localDirectoriesPromise;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
    await fs.chmod(file, 0o600);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function getSqlClient() {
  const databaseUrl = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for Postgres storage.');
  }

  if (!sqlClient || sqlClientUrl !== databaseUrl) {
    sqlClient = neon(databaseUrl);
    sqlClientUrl = databaseUrl;
    schemaPromise = undefined;
    schemaUrl = undefined;
  }
  return sqlClient;
}

async function ensureSchema() {
  const sql = getSqlClient();
  if (!schemaPromise || schemaUrl !== sqlClientUrl) {
    schemaUrl = sqlClientUrl;
    schemaPromise = sql`
      CREATE TABLE IF NOT EXISTS nippou_store (
        namespace TEXT NOT NULL,
        store_key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (namespace, store_key)
      )
    `.catch((error) => {
      schemaPromise = undefined;
      schemaUrl = undefined;
      throw error;
    });
  }
  await schemaPromise;
  return sql;
}

async function readPostgresValue(namespace, storeKey) {
  const sql = await ensureSchema();
  const rows = await sql`
    SELECT encrypted_value
    FROM nippou_store
    WHERE namespace = ${namespace} AND store_key = ${storeKey}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return decryptJson(rows[0].encrypted_value, namespace, storeKey);
}

async function writePostgresValue(namespace, storeKey, value) {
  const sql = await ensureSchema();
  const encryptedValue = encryptJson(value, namespace, storeKey);
  await sql`
    INSERT INTO nippou_store (namespace, store_key, encrypted_value, updated_at)
    VALUES (${namespace}, ${storeKey}, ${encryptedValue}, NOW())
    ON CONFLICT (namespace, store_key)
    DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()
  `;
}

async function deletePostgresValue(namespace, storeKey) {
  const sql = await ensureSchema();
  await sql`
    DELETE FROM nippou_store
    WHERE namespace = ${namespace} AND store_key = ${storeKey}
  `;
}

async function readFileValue(file) {
  await ensureLocalDirectories();
  if (!(await fileExists(file))) return null;
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function deleteFileValue(file) {
  await ensureLocalDirectories();
  await fs.rm(file, { force: true });
}

async function readValue(namespace, storeKey, file) {
  if (resolveStorageBackend() === 'postgres') {
    return readPostgresValue(namespace, storeKey);
  }
  return readFileValue(file);
}

async function writeValue(namespace, storeKey, value, file) {
  if (resolveStorageBackend() === 'postgres') {
    await writePostgresValue(namespace, storeKey, value);
    return;
  }
  await ensureLocalDirectories();
  await writeJsonAtomic(file, value);
}

async function deleteValue(namespace, storeKey, file) {
  if (resolveStorageBackend() === 'postgres') {
    await deletePostgresValue(namespace, storeKey);
    return;
  }
  await deleteFileValue(file);
}

// --- User data (Toggl token, Google accounts) ---

async function getUserData(slackUserId, slackTeamId) {
  const storeKey = userStoreKey(slackUserId, slackTeamId);
  const file = path.join(USERS_DIR, `${storeKey}.json`);
  return (await readValue(USER_NAMESPACE, storeKey, file)) || {};
}

async function saveUserData(slackUserId, data, slackTeamId) {
  const storeKey = userStoreKey(slackUserId, slackTeamId);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('User data must be an object');
  }

  const file = path.join(USERS_DIR, `${storeKey}.json`);
  const existing = await getUserData(slackUserId, slackTeamId);
  await writeValue(USER_NAMESPACE, storeKey, { ...existing, ...data }, file);
}

// --- Slack user token (for posting as user) ---

async function getUserSlackToken(slackUserId, slackTeamId) {
  const storeKey = userStoreKey(slackUserId, slackTeamId);
  const file = path.join(INSTALLATIONS_DIR, `user-${storeKey}.json`);
  const data = await readValue(USER_TOKEN_NAMESPACE, storeKey, file);
  return data ? data.token : null;
}

function installationTeamId(value) {
  const teamId = value.isEnterpriseInstall
    ? value.enterpriseId || (value.enterprise && value.enterprise.id)
    : value.teamId || (value.team && value.team.id);
  return safeId(teamId, 'Slack team ID');
}

// --- Slack Installation Store (for Bolt OAuth) ---

const installationStore = {
  storeInstallation: async (installation) => {
    const teamId = installationTeamId(installation);
    const teamFile = path.join(INSTALLATIONS_DIR, `team-${teamId}.json`);
    await writeValue(INSTALLATION_NAMESPACE, teamId, installation, teamFile);

    // Save per-user token if user authorized with userScopes.
    if (installation.user?.token) {
      const userId = safeId(installation.user.id, 'Slack user ID');
      const storeKey = userStoreKey(userId, teamId);
      const userFile = path.join(INSTALLATIONS_DIR, `user-${storeKey}.json`);
      await writeValue(USER_TOKEN_NAMESPACE, storeKey, {
        userId: installation.user.id,
        token: installation.user.token,
        scopes: installation.user.scopes,
        teamId,
      }, userFile);
    }
  },

  fetchInstallation: async (installQuery) => {
    const teamId = installationTeamId(installQuery);
    const teamFile = path.join(INSTALLATIONS_DIR, `team-${teamId}.json`);
    const installation = await readValue(INSTALLATION_NAMESPACE, teamId, teamFile);
    if (!installation) throw new Error('Installation not found');
    return installation;
  },

  deleteInstallation: async (installQuery) => {
    const teamId = installationTeamId(installQuery);
    const teamFile = path.join(INSTALLATIONS_DIR, `team-${teamId}.json`);
    const installation = await readValue(INSTALLATION_NAMESPACE, teamId, teamFile);
    if (!installation) return;

    const userId = installation.user && installation.user.id;
    if (userId) {
      const safeUserId = safeId(userId, 'Slack user ID');
      const storeKey = userStoreKey(safeUserId, teamId);
      const userFile = path.join(INSTALLATIONS_DIR, `user-${storeKey}.json`);
      await deleteValue(USER_TOKEN_NAMESPACE, storeKey, userFile);
    }
    await deleteValue(INSTALLATION_NAMESPACE, teamId, teamFile);
  },
};

async function checkStorage() {
  const backend = resolveStorageBackend();
  if (backend === 'postgres') {
    await ensureSchema();
  } else {
    await ensureLocalDirectories();
  }
  return { backend };
}

module.exports = {
  getUserData,
  saveUserData,
  getUserSlackToken,
  installationStore,
  writeJsonAtomic,
  checkStorage,
  __testing: {
    parseEncryptionKey,
    encryptJson,
    decryptJson,
    resolveStorageBackend,
    userStoreKey,
  },
};
