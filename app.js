require('dotenv').config({ quiet: true });
process.env.TZ = process.env.NIPPOU_TIMEZONE || 'Asia/Tokyo';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { waitUntil } = require('@vercel/functions');
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { getTogglEntries } = require('./services/toggl');
const {
  generateAuthUrl,
  exchangeCode,
  getCalendarEventSelection,
  getCalendarEvents,
} = require('./services/calendar');
const {
  getUserData,
  saveUserData,
  getUserSlackToken,
  installationStore,
  checkStorage,
} = require('./services/store');
const { resolveReportSchedule } = require('./services/report-date');
const { generateStructuredReport, generatePreview } = require('./services/ai');
const { buildSlackMrkdwn } = require('./services/report');
const {
  filterReportLines,
  normalizeReportFilters,
} = require('./services/report-filters');
const {
  DEFAULT_NOTION_MAPPING,
  exchangeNotionCode,
  fetchTaskItems,
  generateNotionAuthUrl,
  isNotionConfigured,
  resolveNotionDatabase,
  revokeNotionConnection,
  validateTaskSource,
} = require('./services/tasks');
const {
  buildOnboardingMessage,
  buildReportModal,
  validateHitokoto,
} = require('./services/slack-ui');
const { respondEphemeral } = require('./services/slack-command-response');

const REQUIRED_SLACK_CONFIG = [
  'SLACK_SIGNING_SECRET',
  'SLACK_CLIENT_ID',
  'SLACK_CLIENT_SECRET',
  'SLACK_STATE_SECRET',
];

const missingSlackConfig = REQUIRED_SLACK_CONFIG.filter((name) => {
  const value = process.env[name];
  if (typeof value !== 'string' || !value.trim()) return true;
  if (name === 'SLACK_STATE_SECRET') {
    return value.length < 32 || value === 'nippou-slack-state-secret';
  }
  return false;
});

if (missingSlackConfig.length > 0) {
  // A deployable configuration-pending handler lets us obtain the production
  // URL before creating/configuring the Slack app. No secret values are
  // returned by these routes.
  const pendingApp = express();
  pendingApp.use(express.static(path.join(__dirname, 'public')));
  pendingApp.get('/settings', (_req, res) => res.redirect(302, '/settings.html'));
  pendingApp.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      ok: false,
      status: 'configuration_required',
      missing: missingSlackConfig,
    });
  });
  pendingApp.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      ok: false,
      status: 'configuration_required',
      healthUrl: '/healthz',
      settingsUrl: '/settings.html',
    });
  });

  module.exports = pendingApp;

  if (require.main === module) {
    const port = process.env.PORT || 3000;
    pendingApp.listen(port, () => {
      console.log(`nippou-slack configuration page is running on port ${port}`);
    });
  }
} else {
// --- Receiver (Express + Slack OAuth) ---

const STATE_SECRET = process.env.SLACK_STATE_SECRET;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: STATE_SECRET,
  redirectUri: process.env.APP_URL
    ? `${process.env.APP_URL.replace(/\/$/, '')}/slack/oauth_redirect`
    : undefined,
  scopes: ['commands', 'chat:write'],
  installerOptions: {
    directInstall: true,
    userScopes: ['chat:write'],
    redirectUriPath: '/slack/oauth_redirect',
  },
  installationStore,
});

const app = new App({ receiver });

// --- Static files & settings page ---

receiver.router.use(express.static(path.join(__dirname, 'public')));

receiver.router.get('/settings', (_req, res) => {
  // Vercel serves public/ from its CDN, while Express still serves it locally.
  res.redirect(302, '/settings.html');
});

receiver.router.get('/healthz', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const storage = await checkStorage();
    res.json({ ok: true, storage: storage.backend });
  } catch (error) {
    console.error('Health check error:', error.message);
    res.status(503).json({ ok: false, error: 'Storage is unavailable' });
  }
});

/**
 * Keep work started after a Slack acknowledgement alive on Vercel. Locally we
 * await it so command-line development and tests retain deterministic errors.
 * The guarded promise always resolves after logging to avoid unhandled
 * rejections from a failed modal update or Slack post.
 */
function continueAfterAck(task, label) {
  const guarded = Promise.resolve(task).catch((error) => {
    console.error(`${label}:`, error);
  });

  if (process.env.VERCEL) {
    waitUntil(guarded);
    return Promise.resolve();
  }

  return guarded;
}

function getTeamId(payload = {}) {
  return payload.team_id || payload.team?.id || payload.enterprise_id || payload.enterprise?.id;
}

// --- Settings token (signed URL for web UI auth) ---

const TOKEN_TTL = 3600000; // 1 hour
const isSlackId = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]+$/.test(value);

function generateSignedToken(purpose, userId, teamId) {
  if (!isSlackId(userId) || !isSlackId(teamId)) {
    throw new TypeError('Valid Slack user and team IDs are required');
  }
  const expires = Date.now() + TOKEN_TTL;
  const payload = `${purpose}:${userId}:${teamId}:${expires}`;
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return `${payload}:${sig}`;
}

function verifySignedToken(token, expectedPurpose) {
  if (typeof token !== 'string') return null;
  const parts = token.split(':');
  if (parts.length !== 5) return null;
  const [purpose, userId, teamId, expires, sig] = parts;
  if (purpose !== expectedPurpose || !isSlackId(userId) || !isSlackId(teamId)) return null;
  if (!/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) return null;

  const expected = crypto
    .createHmac('sha256', STATE_SECRET)
    .update(`${purpose}:${userId}:${teamId}:${expires}`)
    .digest();
  const actual = Buffer.from(sig, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return { userId, teamId };
}

const generateSettingsToken = (userId, teamId) => generateSignedToken('settings', userId, teamId);
const verifySettingsToken = (token) => verifySignedToken(token, 'settings');
const generateGoogleState = (userId, teamId) => generateSignedToken('google', userId, teamId);
const verifyGoogleState = (token) => verifySignedToken(token, 'google');
const generateNotionState = (userId, teamId) => generateSignedToken('notion', userId, teamId);
const verifyNotionState = (token) => verifySignedToken(token, 'notion');

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const identity = verifySettingsToken(token);
  if (!identity) return res.status(401).json({ error: 'Unauthorized' });
  req.slackUserId = identity.userId;
  req.slackTeamId = identity.teamId;
  next();
}

function stringSetting(value, maxLength = 2000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError('Setting values must be strings');
  return value.trim().slice(0, maxLength);
}

function readReportFilters(userData = {}) {
  try {
    return normalizeReportFilters(userData.reportFilters);
  } catch (error) {
    console.warn('Stored report filters are invalid; defaults will be used:', error.message);
    return normalizeReportFilters();
  }
}

function withReportFallback(lines, fallback) {
  return Array.isArray(lines) && lines.length > 0 ? lines : [fallback];
}

function readTaskSources(userData = {}) {
  const stored = userData.taskSources && typeof userData.taskSources === 'object'
    ? userData.taskSources
    : {};
  const notion = stored.notion && typeof stored.notion === 'object' ? stored.notion : {};
  const json = stored.json && typeof stored.json === 'object' ? stored.json : {};
  return {
    notion: {
      enabled: Boolean(notion.enabled),
      databaseUrl: stringSetting(notion.databaseUrl),
      databaseId: stringSetting(notion.databaseId),
      dataSourceId: stringSetting(notion.dataSourceId),
      mapping: { ...DEFAULT_NOTION_MAPPING, ...(notion.mapping || {}) },
    },
    json: {
      enabled: Boolean(json.enabled),
      name: stringSetting(json.name, 100),
      url: stringSetting(json.url),
      bearerToken: stringSetting(json.bearerToken, 8000),
    },
  };
}

function publicTaskSources(userData = {}) {
  const taskSources = readTaskSources(userData);
  const connected = Boolean(userData.notionConnection?.accessToken);
  return {
    notion: {
      ...taskSources.notion,
      available: isNotionConfigured(),
      connected,
      workspaceName: connected ? stringSetting(userData.notionConnection.workspaceName, 200) : '',
    },
    json: {
      enabled: taskSources.json.enabled,
      name: taskSources.json.name,
      url: taskSources.json.url,
      hasBearerToken: Boolean(taskSources.json.bearerToken),
    },
  };
}

function notionSource(userData, override = {}) {
  const stored = readTaskSources(userData).notion;
  return {
    provider: 'notion',
    ...stored,
    ...override,
    mapping: { ...stored.mapping, ...(override.mapping || {}) },
    connection: userData.notionConnection,
  };
}

function jsonSource(userData, override = {}) {
  const stored = readTaskSources(userData).json;
  return {
    provider: 'json',
    ...stored,
    ...override,
    bearerToken: stringSetting(override.bearerToken) || stored.bearerToken,
  };
}

function configuredTaskSources(userData) {
  const taskSources = readTaskSources(userData);
  const sources = [];
  if (taskSources.notion.enabled && userData.notionConnection?.accessToken
    && (taskSources.notion.databaseUrl || taskSources.notion.dataSourceId)) {
    sources.push(notionSource(userData));
  }
  if (taskSources.json.enabled && taskSources.json.url) {
    sources.push(jsonSource(userData));
  }
  return sources;
}

function mergeSourceLines(...groups) {
  const seen = new Set();
  const lines = [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (typeof value !== 'string') continue;
      const title = value.trim().replace(/^(?:[-*+•・]\s*)/, '').trim();
      if (!title || seen.has(title)) continue;
      seen.add(title);
      lines.push(`・${title}`);
    }
  }
  return lines;
}

// --- Settings API ---

receiver.router.use('/api/settings', (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Expires: '0',
  });
  next();
});

receiver.router.get('/api/settings', authMiddleware, async (req, res) => {
  try {
    const data = await getUserData(req.slackUserId, req.slackTeamId);
    res.json({
      togglToken: data.togglToken || '',
      ai: data.ai || {},
      googleAccounts: (data.googleAccounts || []).map((a) => ({ email: a.email })),
      googleAuthUrl: generateAuthUrl(generateGoogleState(req.slackUserId, req.slackTeamId)),
      notionAuthUrl: isNotionConfigured()
        ? generateNotionAuthUrl(generateNotionState(req.slackUserId, req.slackTeamId))
        : '',
      reportFilters: readReportFilters(data),
      taskSources: publicTaskSources(data),
    });
  } catch (error) {
    console.error('Settings read error:', error.message);
    res.status(500).json({ error: 'Settings could not be loaded' });
  }
});

receiver.router.put('/api/settings', express.json(), authMiddleware, async (req, res) => {
  try {
    const {
      togglToken,
      ai,
      reportFilters,
      taskSources,
    } = req.body;
    const update = {};
    if (togglToken !== undefined) update.togglToken = togglToken;
    if (ai !== undefined) update.ai = ai;
    if (reportFilters !== undefined) {
      update.reportFilters = normalizeReportFilters(reportFilters);
    }
    if (taskSources !== undefined) {
      if (!taskSources || typeof taskSources !== 'object' || Array.isArray(taskSources)) {
        throw new TypeError('Task sources must be an object');
      }
      const existingData = await getUserData(req.slackUserId, req.slackTeamId);
      const existing = readTaskSources(existingData);

      const incomingNotion = taskSources.notion && typeof taskSources.notion === 'object'
        ? taskSources.notion
        : {};
      const notion = {
        enabled: Boolean(incomingNotion.enabled),
        databaseUrl: stringSetting(incomingNotion.databaseUrl),
        databaseId: existing.notion.databaseId,
        dataSourceId: existing.notion.dataSourceId,
        mapping: { ...DEFAULT_NOTION_MAPPING },
      };
      if (incomingNotion.mapping !== undefined) {
        if (!incomingNotion.mapping || typeof incomingNotion.mapping !== 'object'
          || Array.isArray(incomingNotion.mapping)) {
          throw new TypeError('Notion mapping must be an object');
        }
        for (const key of Object.keys(DEFAULT_NOTION_MAPPING)) {
          notion.mapping[key] = stringSetting(
            incomingNotion.mapping[key] === undefined
              ? DEFAULT_NOTION_MAPPING[key]
              : incomingNotion.mapping[key],
            200,
          );
          if (!notion.mapping[key]) throw new TypeError(`Notion mapping.${key} is required`);
        }
      } else {
        notion.mapping = existing.notion.mapping;
      }

      const databaseChanged = notion.databaseUrl !== existing.notion.databaseUrl;
      const mappingChanged = Object.keys(DEFAULT_NOTION_MAPPING)
        .some((key) => notion.mapping[key] !== existing.notion.mapping[key]);
      const enablingNotion = notion.enabled && !existing.notion.enabled;
      if (databaseChanged) {
        notion.databaseId = '';
      }
      // Mapping edits made while Notion is disabled must still force a fresh
      // property check the next time the source is enabled.
      if (databaseChanged || mappingChanged) {
        notion.dataSourceId = '';
      }
      if (notion.enabled) {
        if (!existingData.notionConnection?.accessToken) {
          throw new TypeError('Notionを先に接続してください');
        }
        if (!notion.databaseUrl) throw new TypeError('NotionのタスクDB URLを入力してください');
        if (!notion.dataSourceId || databaseChanged || mappingChanged || enablingNotion) {
          const resolved = await resolveNotionDatabase(
            existingData.notionConnection.accessToken,
            notion.databaseUrl,
          );
          notion.databaseId = resolved.databaseId;
          notion.dataSourceId = resolved.dataSourceId;
          const availableProperties = new Map(
            resolved.properties.map((property) => [property.name, property.type]),
          );
          const expectedPropertyTypes = {
            title: ['title'],
            status: ['status', 'select'],
            scheduledDate: ['date'],
            dueDate: ['date'],
            completedAt: ['date'],
            category: ['select', 'multi_select', 'status'],
            reportable: ['checkbox'],
            confidentiality: ['select', 'multi_select', 'status'],
          };
          const missing = Object.keys(expectedPropertyTypes)
            .map((key) => notion.mapping[key])
            .filter((propertyName) => !availableProperties.has(propertyName));
          if (missing.length > 0) {
            throw new TypeError(`Notionに見つからない項目があります: ${missing.join(', ')}`);
          }
          const incompatible = Object.entries(expectedPropertyTypes)
            .filter(([key, allowedTypes]) => !allowedTypes.includes(
              availableProperties.get(notion.mapping[key]),
            ))
            .map(([key]) => notion.mapping[key]);
          if (incompatible.length > 0) {
            throw new TypeError(`Notionの項目種類が合いません: ${incompatible.join(', ')}`);
          }
        }
        validateTaskSource({
          provider: 'notion',
          ...notion,
          connection: existingData.notionConnection,
        });
      }

      const incomingJson = taskSources.json && typeof taskSources.json === 'object'
        ? taskSources.json
        : {};
      const json = {
        enabled: Boolean(incomingJson.enabled),
        name: stringSetting(incomingJson.name, 100),
        url: stringSetting(incomingJson.url),
        bearerToken: stringSetting(incomingJson.bearerToken, 8000)
          || existing.json.bearerToken,
      };
      if (!json.url) json.bearerToken = '';
      if (json.enabled) validateTaskSource({ provider: 'json', ...json });

      update.taskSources = { notion, json };
    }
    await saveUserData(req.slackUserId, update, req.slackTeamId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Settings update error:', error.message);
    if (error instanceof TypeError) {
      res.status(400).json({ error: error.message });
      return;
    }
    res.status(500).json({ error: 'Settings could not be saved' });
  }
});

receiver.router.post(
  '/api/task-sources/test',
  express.json(),
  authMiddleware,
  async (req, res) => {
    try {
      const userData = await getUserData(req.slackUserId, req.slackTeamId);
      const schedule = resolveReportSchedule('');
      const provider = stringSetting(req.body?.provider, 20);
      const config = req.body?.config && typeof req.body.config === 'object'
        ? req.body.config
        : {};

      let source;
      if (provider === 'notion') {
        if (!userData.notionConnection?.accessToken) {
          res.status(400).json({ error: 'Notionを先に接続してください' });
          return;
        }
        source = notionSource(userData, {
          enabled: true,
          databaseUrl: stringSetting(config.databaseUrl),
          mapping: config.mapping,
          databaseId: '',
          dataSourceId: '',
        });
        const resolved = await resolveNotionDatabase(
          userData.notionConnection.accessToken,
          source.databaseUrl,
        );
        source.databaseId = resolved.databaseId;
        source.dataSourceId = resolved.dataSourceId;
      } else if (provider === 'json') {
        source = jsonSource(userData, {
          enabled: true,
          url: stringSetting(config.url),
          bearerToken: stringSetting(config.bearerToken, 8000),
        });
      } else {
        res.status(400).json({ error: '対応していないタスク連携です' });
        return;
      }

      const result = await fetchTaskItems(
        source,
        schedule.dateKey,
        schedule.nextBusinessDateKey,
        {
          onConnectionRefresh: async (notionConnection) => {
            await saveUserData(
              req.slackUserId,
              { notionConnection },
              req.slackTeamId,
            );
          },
        },
      );
      const reportFilters = req.body?.reportFilters === undefined
        ? readReportFilters(userData)
        : normalizeReportFilters(req.body.reportFilters);
      res.json({
        done: filterReportLines(result.done, reportFilters),
        will: filterReportLines(result.will, reportFilters),
      });
    } catch (error) {
      console.error('Task source test error:', error.message);
      res.status(400).json({ error: error.message || '接続を確認できませんでした' });
    }
  },
);

receiver.router.post(
  '/api/calendar/test',
  express.json(),
  authMiddleware,
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const userData = await getUserData(req.slackUserId, req.slackTeamId);
      const accounts = userData.googleAccounts || [];
      if (accounts.length === 0) {
        res.status(400).json({ error: 'Googleカレンダーを先に接続してください' });
        return;
      }

      const reportFilters = req.body?.reportFilters === undefined
        ? readReportFilters(userData)
        : normalizeReportFilters(req.body.reportFilters);
      const schedule = resolveReportSchedule('');
      let saveQueue = Promise.resolve();
      const selections = await Promise.all(accounts.map(async (account) => (
        getCalendarEventSelection(
          account.tokens,
          schedule.date,
          async (refreshed) => {
            account.tokens = refreshed;
            const save = saveQueue.then(() => saveUserData(
              req.slackUserId,
              { googleAccounts: accounts },
              req.slackTeamId,
            ));
            saveQueue = save.catch(() => {});
            await save;
          },
          { reportFilters },
        )
      )));

      const included = mergeSourceLines(...selections.map((selection) => selection.included));
      const excluded = [];
      const seenExcluded = new Set();
      for (const selection of selections) {
        for (const item of selection.excluded) {
          const key = `${item.title}\0${item.reason}`;
          if (seenExcluded.has(key)) continue;
          seenExcluded.add(key);
          excluded.push(item);
        }
      }

      res.json({
        dateLabel: schedule.nextBusinessDateLabel,
        included,
        excluded,
      });
    } catch (error) {
      console.error('Calendar test error:', error.message);
      res.status(400).json({ error: error.message || 'カレンダーを確認できませんでした' });
    }
  },
);

receiver.router.post(
  '/api/task-sources/notion/disconnect',
  authMiddleware,
  async (req, res) => {
    try {
      const userData = await getUserData(req.slackUserId, req.slackTeamId);
      if (userData.notionConnection) {
        try {
          await revokeNotionConnection(userData.notionConnection);
        } catch (error) {
          console.error('Notion revoke error:', error.message);
        }
      }
      const taskSources = readTaskSources(userData);
      taskSources.notion.enabled = false;
      await saveUserData(
        req.slackUserId,
        { notionConnection: null, taskSources },
        req.slackTeamId,
      );
      res.json({ ok: true });
    } catch (error) {
      console.error('Notion disconnect error:', error.message);
      res.status(500).json({ error: 'Notionの接続を解除できませんでした' });
    }
  },
);

receiver.router.post('/api/preview', express.json(), authMiddleware, async (req, res) => {
  try {
    const text = await generatePreview(req.body.ai);
    res.json({ text });
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: 'Preview generation failed' });
  }
});

// --- Google OAuth callback route ---

receiver.router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const identity = verifyGoogleState(state);
  if (!code || !identity) {
    res.status(400).send('パラメータが不足しています');
    return;
  }

  const { userId: slackUserId, teamId: slackTeamId } = identity;

  try {
    const { tokens, email } = await exchangeCode(code);
    const userData = await getUserData(slackUserId, slackTeamId);
    const accounts = userData.googleAccounts || [];

    // Update or add account
    const existing = accounts.findIndex((a) => a.email === email);
    if (existing >= 0) {
      accounts[existing].tokens = tokens;
    } else {
      accounts.push({ email, tokens });
    }
    await saveUserData(slackUserId, { googleAccounts: accounts }, slackTeamId);

    // Notify user via DM
    try {
      const installation = await installationStore.fetchInstallation({ teamId: slackTeamId });
      if (installation.bot?.token) {
        const botClient = new WebClient(installation.bot.token);
        await botClient.chat.postMessage({
          channel: slackUserId,
          text: `Googleカレンダー連携完了: *${email}*\n日報に予定が自動で反映されます。`,
        });
      }
    } catch (_) {
      // DM送信失敗は無視
    }

    res.send('<h2>Googleカレンダー連携が完了しました！このタブを閉じてSlackに戻ってください。</h2>');
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(500).send('認証に失敗しました。もう一度お試しください。');
  }
});

// --- Notion OAuth callback route ---

receiver.router.get('/notion/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const identity = verifyNotionState(state);
  const baseUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`)
    .replace(/\/$/, '');

  if (error || !code || !identity) {
    const fallback = identity
      ? `${baseUrl}/settings.html?token=${encodeURIComponent(
        generateSettingsToken(identity.userId, identity.teamId),
      )}&notion=error#taskSources`
      : `${baseUrl}/settings.html?notion=error#taskSources`;
    res.redirect(302, fallback);
    return;
  }

  try {
    const notionConnection = await exchangeNotionCode(code);
    await saveUserData(
      identity.userId,
      { notionConnection },
      identity.teamId,
    );
    const settingsToken = generateSettingsToken(identity.userId, identity.teamId);
    res.redirect(
      302,
      `${baseUrl}/settings.html?token=${encodeURIComponent(
        settingsToken,
      )}&notion=connected#taskSources`,
    );
  } catch (oauthError) {
    console.error('Notion OAuth error:', oauthError.message);
    const settingsToken = generateSettingsToken(identity.userId, identity.teamId);
    res.redirect(
      302,
      `${baseUrl}/settings.html?token=${encodeURIComponent(
        settingsToken,
      )}&notion=error#taskSources`,
    );
  }
});

// --- Modal builders ---

function buildSetupModal(userData) {
  const googleStatus = (userData.googleAccounts || []).length > 0
    ? `連携済み: ${userData.googleAccounts.map((a) => a.email).join(', ')}`
    : '未連携';

  return {
    type: 'modal',
    callback_id: 'setup_submit',
    title: { type: 'plain_text', text: '日報セットアップ' },
    submit: { type: 'plain_text', text: '保存' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'input',
        block_id: 'toggl_block',
        label: { type: 'plain_text', text: 'Toggl API トークン' },
        element: {
          type: 'plain_text_input',
          action_id: 'toggl_input',
          placeholder: { type: 'plain_text', text: 'Toggl > Profile > API Token' },
          ...(userData.togglToken ? { initial_value: userData.togglToken } : {}),
        },
        hint: { type: 'plain_text', text: 'https://track.toggl.com/profile の下部にあります' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Googleカレンダー:* ${googleStatus}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Googleカレンダーの連携は保存後に `/nippou connect-google` で行えます',
          },
        ],
      },
    ],
  };
}

function buildLoadingModal(channelId, dateLabel, tomorrowLabel) {
  return {
    type: 'modal',
    callback_id: 'nippou_loading',
    title: { type: 'plain_text', text: '日報を作成中' },
    close: { type: 'plain_text', text: '閉じる' },
    private_metadata: JSON.stringify({ channelId, dateLabel, tomorrowLabel }),
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${dateLabel}の記録と、次の営業日（${tomorrowLabel}）の予定・タスクを取得しています…`,
      },
    }],
  };
}

// --- Slash command: /nippou ---

app.command('/nippou', async (context) => {
  const { ack } = context;
  await ack();
  const task = handleNippouCommand(context).catch(async (error) => {
    console.error('Slash command processing error:', error);
    await respondEphemeral(
      context.respond,
      'にっぽうにぎりの処理に失敗しました。少し待ってからもう一度お試しください。',
    );
  });
  return continueAfterAck(task, 'Slash command error response failed');
});

async function handleNippouCommand({ command, client, body, respond }) {
  const userId = command.user_id;
  const teamId = command.team_id || getTeamId(body);
  const subcommand = (command.text || '').trim();

  // --- /nippou setup ---
  if (subcommand === 'setup') {
    const userData = await getUserData(userId, teamId);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildSetupModal(userData),
    });
    return;
  }

  // --- /nippou settings ---
  if (subcommand === 'settings') {
    const settingsToken = generateSettingsToken(userId, teamId);
    const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const settingsUrl = `${baseUrl}/settings.html?token=${encodeURIComponent(settingsToken)}`;
    await respondEphemeral(
      respond,
      `以下のリンクから設定ページを開いてください（1時間有効）:\n<${settingsUrl}|設定ページを開く>`,
    );
    return;
  }

  // --- /nippou tasks ---
  if (subcommand === 'tasks') {
    const settingsToken = generateSettingsToken(userId, teamId);
    const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const settingsUrl = `${baseUrl}/settings.html?token=${encodeURIComponent(
      settingsToken,
    )}#taskSources`;
    await respondEphemeral(
      respond,
      `タスク管理の連携は以下から設定できます（1時間有効・連携は任意です）:\n<${settingsUrl}|タスク管理を設定する>`,
    );
    return;
  }

  // --- /nippou connect-google ---
  if (subcommand === 'connect-google') {
    const authUrl = generateAuthUrl(generateGoogleState(userId, teamId));
    await respondEphemeral(
      respond,
      `以下のリンクからGoogleカレンダーを連携してください:\n<${authUrl}|Googleアカウントを連携する>`,
    );
    return;
  }

  // --- /nippou set-daily ---
  if (subcommand === 'set-daily') {
    await saveUserData(userId, { dailyChannelId: command.channel_id }, teamId);
    await respondEphemeral(
      respond,
      `日報の投稿先を <#${command.channel_id}> に設定しました。`,
    );
    return;
  }

  // --- /nippou help ---
  if (subcommand === 'help') {
    await respondEphemeral(
      respond,
      [
        '*にっぽうにぎり - 使い方*',
        '`/nippou` - 日報を作成・送信',
        '`/nippou 2026-07-17` - 指定日の日報を作成・送信',
        '`/nippou 7/17` - 年を省略して今年の指定日の日報を作成',
        '`/nippou setup` - Toggl APIトークンを設定',
        '`/nippou settings` - Web設定ページを開く（AI・スタイル・連携）',
        '`/nippou tasks` - Notion・JSONタスク連携を設定（任意）',
        '`/nippou connect-google` - Googleカレンダーを連携',
        '`/nippou set-daily` - 実行中のチャンネルを日報の投稿先に設定',
        '`/nippou help` - このヘルプを表示',
      ].join('\n'),
    );
    return;
  }

  // --- /nippou (メイン: 日報作成) ---
  let reportDate;
  try {
    reportDate = resolveReportSchedule(subcommand);
  } catch (error) {
    await respondEphemeral(respond, error.message);
    return;
  }

  const baseDate = reportDate.date;
  const tomorrowDateKey = reportDate.nextBusinessDateKey;
  const dateLabel = reportDate.dateLabel;
  const tomorrowLabel = reportDate.nextBusinessDateLabel;
  const userData = await getUserData(userId, teamId);
  const targetChannelId = userData.dailyChannelId || command.channel_id;
  const reportFilters = readReportFilters(userData);

  const taskSources = configuredTaskSources(userData);
  const hasConfiguredSource = Boolean(
    userData.togglToken
    || (userData.googleAccounts || []).length
    || taskSources.length,
  );

  if (!hasConfiguredSource) {
    await Promise.all([
      client.views.open({
        trigger_id: body.trigger_id,
        view: buildSetupModal(userData),
      }),
      respondEphemeral(respond, buildOnboardingMessage()),
    ]);
    return;
  }

  // Slackのtrigger_idは短時間で失効するため、外部APIを呼ぶ前にモーダルを開く。
  const loadingResult = await client.views.open({
    trigger_id: body.trigger_id,
    view: buildLoadingModal(targetChannelId, dateLabel, tomorrowLabel),
  });

  const accounts = userData.googleAccounts || [];
  const sourceWarnings = [];
  let integrationSaveQueue = Promise.resolve();
  const persistIntegrationUpdate = (update) => {
    const save = integrationSaveQueue.then(
      () => saveUserData(userId, update, teamId),
    );
    integrationSaveQueue = save.catch(() => {});
    return save;
  };
  const togglPromise = userData.togglToken
    ? getTogglEntries(userData.togglToken, baseDate).catch((error) => {
      console.error('Toggl error:', error.message);
      sourceWarnings.push('Toggl');
      return [];
    })
    : Promise.resolve([]);
  const calendarPromise = Promise.all(accounts.map(async (account) => {
    try {
      return await getCalendarEvents(
        account.tokens,
        baseDate,
        async (refreshed) => {
          account.tokens = refreshed;
          await persistIntegrationUpdate({ googleAccounts: accounts });
        },
        { reportFilters },
      );
    } catch (error) {
      console.error(`Calendar error (${account.email}):`, error.message);
      sourceWarnings.push('Googleカレンダー');
      return [];
    }
  }));
  const tasksPromise = Promise.all(taskSources.map(async (source) => {
    try {
      return await fetchTaskItems(
        source,
        reportDate.dateKey,
        tomorrowDateKey,
        {
          onConnectionRefresh: async (notionConnection) => {
            userData.notionConnection = notionConnection;
            await persistIntegrationUpdate({ notionConnection });
          },
        },
      );
    } catch (error) {
      console.error(`Task source error (${source.provider}):`, error.message);
      sourceWarnings.push(source.provider === 'notion' ? 'Notion' : 'JSONタスク');
      return { done: [], will: [] };
    }
  }));

  // Toggl、カレンダー、タスク連携は独立しているため並列取得する。
  const [togglLines, calendarGroups, taskGroups] = await Promise.all([
    togglPromise,
    calendarPromise,
    tasksPromise,
  ]);

  let todayLines = withReportFallback(filterReportLines(mergeSourceLines(
    togglLines,
    ...taskGroups.map((result) => result.done),
  ), reportFilters), '・（記録なし）');
  let tomorrowLines = withReportFallback(filterReportLines(mergeSourceLines(
    ...calendarGroups,
    ...taskGroups.map((result) => result.will),
  ), reportFilters), '・（予定なし）');

  // AI generation (if configured and API key available)
  let aiTodayLines = todayLines;
  let aiTomorrowLines = tomorrowLines;
  try {
    const aiReport = await generateStructuredReport(
      userData.ai || {},
      todayLines,
      tomorrowLines,
      dateLabel,
      tomorrowLabel,
    );
    aiTodayLines = withReportFallback(
      filterReportLines(aiReport.todayItems, reportFilters),
      '・（記録なし）',
    );
    aiTomorrowLines = withReportFallback(
      filterReportLines(aiReport.tomorrowItems, reportFilters),
      '・（予定なし）',
    );
  } catch (e) {
    console.error('AI generation error:', e.message);
    // Fall back to raw data in the interactive review modal.
  }

  await client.views.update({
    view_id: loadingResult.view.id,
    view: buildReportModal(
      targetChannelId,
      aiTodayLines,
      aiTomorrowLines,
      dateLabel,
      tomorrowLabel,
      reportDate.dateKey,
      tomorrowDateKey,
      [...new Set(sourceWarnings)],
    ),
  });
}

// --- Modal submission: setup ---

app.view('setup_submit', async ({ ack, view, body }) => {
  const togglToken = view.state.values.toggl_block.toggl_input.value;

  // Validate Toggl token
  try {
    const res = await fetch('https://api.track.toggl.com/api/v9/me', {
      headers: {
        Authorization: `Basic ${Buffer.from(`${togglToken}:api_token`).toString('base64')}`,
      },
    });
    if (!res.ok) {
      await ack({
        response_action: 'errors',
        errors: { toggl_block: 'トークンが無効です。正しいAPIトークンを入力してください。' },
      });
      return;
    }
  } catch (_) {
    await ack({
      response_action: 'errors',
      errors: { toggl_block: 'Toggl APIに接続できませんでした。' },
    });
    return;
  }

  await ack();
  return continueAfterAck(
    saveSetupData(body.user.id, getTeamId(body), togglToken),
    'Setup save error',
  );
});

async function saveSetupData(userId, teamId, togglToken) {
  await saveUserData(userId, { togglToken }, teamId);
}

// --- Modal submission: nippou ---

app.view('nippou_submit', async ({ ack, view, body, client }) => {
  const { comment, errors } = validateHitokoto(view);
  if (errors) {
    await ack({ response_action: 'errors', errors });
    return;
  }
  await ack();

  return continueAfterAck(
    postNippouSubmission({ view, body, client, comment }),
    'Daily report post error',
  );
});

async function postNippouSubmission({ view, body, client, comment }) {
  const userId = body.user.id;
  const teamId = getTeamId(body);
  const { channelId, dateLabel, tomorrowLabel } = JSON.parse(view.private_metadata);

  const todayText = view.state.values.today_block.today_input.value;
  const tomorrowText = view.state.values.tomorrow_block.tomorrow_input.value;
  const message = buildSlackMrkdwn({
    todayItems: todayText,
    tomorrowItems: tomorrowText,
  }, { dateLabel, tomorrowLabel, comment });

  // Post as user if user token is available, otherwise fallback to bot
  const userToken = await getUserSlackToken(userId, teamId);
  if (userToken) {
    const userClient = new WebClient(userToken);
    await userClient.chat.postMessage({ channel: channelId, text: message });
  } else {
    // chat:write.customizeに依存せず、通常のボット投稿へ安全にフォールバックする。
    await client.chat.postMessage({ channel: channelId, text: message });
  }
}

// Vercel invokes the Express handler directly. Starting a listener is only for
// local `node app.js` / `npm start` usage.
module.exports = receiver.app;

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.start(port)
    .then(() => console.log(`nippou-slack is running on port ${port}`))
    .catch((error) => {
      console.error('Startup error:', error);
      process.exitCode = 1;
    });
}
}
