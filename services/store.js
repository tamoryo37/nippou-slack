const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const STORE_DIR = path.join(__dirname, '..', 'store');
const USERS_DIR = path.join(STORE_DIR, 'users');
const INSTALLATIONS_DIR = path.join(STORE_DIR, 'installations');

for (const dir of [STORE_DIR, USERS_DIR, INSTALLATIONS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  else fs.chmodSync(dir, 0o700);
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

// --- User data (Toggl token, Google accounts) ---

function getUserData(slackUserId) {
  const file = path.join(USERS_DIR, `${safeId(slackUserId, 'Slack user ID')}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function saveUserData(slackUserId, data) {
  const file = path.join(USERS_DIR, `${safeId(slackUserId, 'Slack user ID')}.json`);
  const existing = getUserData(slackUserId);
  writeJsonAtomic(file, { ...existing, ...data });
}

// --- Slack user token (for posting as user) ---

function getUserSlackToken(slackUserId) {
  const file = path.join(INSTALLATIONS_DIR, `user-${safeId(slackUserId, 'Slack user ID')}.json`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return data.token;
}

// --- Slack Installation Store (for Bolt OAuth) ---

const installationStore = {
  storeInstallation: async (installation) => {
    const teamId = installation.isEnterpriseInstall
      ? installation.enterprise.id
      : installation.team.id;

    // Save team-level installation (bot token)
    safeId(teamId, 'Slack team ID');
    const teamFile = path.join(INSTALLATIONS_DIR, `team-${teamId}.json`);
    writeJsonAtomic(teamFile, installation);

    // Save per-user token if user authorized with userScopes
    if (installation.user?.token) {
      const userId = safeId(installation.user.id, 'Slack user ID');
      const userFile = path.join(INSTALLATIONS_DIR, `user-${userId}.json`);
      writeJsonAtomic(userFile, {
        userId: installation.user.id,
        token: installation.user.token,
        scopes: installation.user.scopes,
        teamId,
      });
    }
  },

  fetchInstallation: async (installQuery) => {
    const teamId = installQuery.isEnterpriseInstall
      ? installQuery.enterpriseId
      : installQuery.teamId;
    safeId(teamId, 'Slack team ID');
    const teamFile = path.join(INSTALLATIONS_DIR, `team-${teamId}.json`);
    if (!fs.existsSync(teamFile)) throw new Error('Installation not found');
    return JSON.parse(fs.readFileSync(teamFile, 'utf-8'));
  },

  deleteInstallation: async (installQuery) => {
    const teamId = installQuery.isEnterpriseInstall
      ? installQuery.enterpriseId
      : installQuery.teamId;
    safeId(teamId, 'Slack team ID');
    const teamFile = path.join(INSTALLATIONS_DIR, `team-${teamId}.json`);
    if (fs.existsSync(teamFile)) {
      const installation = JSON.parse(fs.readFileSync(teamFile, 'utf-8'));
      const userId = installation.user && installation.user.id;
      if (userId) {
        const userFile = path.join(
          INSTALLATIONS_DIR,
          `user-${safeId(userId, 'Slack user ID')}.json`
        );
        if (fs.existsSync(userFile)) fs.unlinkSync(userFile);
      }
      fs.unlinkSync(teamFile);
    }
  },
};

module.exports = {
  getUserData,
  saveUserData,
  getUserSlackToken,
  installationStore,
  writeJsonAtomic,
};
