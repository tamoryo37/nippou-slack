require('dotenv').config({ quiet: true });
process.env.TZ = process.env.NIPPOU_TIMEZONE || 'Asia/Tokyo';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { waitUntil } = require('@vercel/functions');
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { getTogglEntries } = require('./services/toggl');
const { generateAuthUrl, exchangeCode, getCalendarEvents } = require('./services/calendar');
const {
  getUserData,
  saveUserData,
  getUserSlackToken,
  installationStore,
  checkStorage,
} = require('./services/store');
const { nextBusinessDay, formatDateLabel } = require('./services/holidays');
const { generateStructuredReport, generatePreview } = require('./services/ai');
const { buildSlackMrkdwn } = require('./services/report');
const { buildReportModal, validateHitokoto } = require('./services/slack-ui');

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

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const identity = verifySettingsToken(token);
  if (!identity) return res.status(401).json({ error: 'Unauthorized' });
  req.slackUserId = identity.userId;
  req.slackTeamId = identity.teamId;
  next();
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
    });
  } catch (error) {
    console.error('Settings read error:', error.message);
    res.status(500).json({ error: 'Settings could not be loaded' });
  }
});

receiver.router.put('/api/settings', express.json(), authMiddleware, async (req, res) => {
  try {
    const { togglToken, ai } = req.body;
    const update = {};
    if (togglToken !== undefined) update.togglToken = togglToken;
    if (ai !== undefined) update.ai = ai;
    await saveUserData(req.slackUserId, update, req.slackTeamId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Settings update error:', error.message);
    res.status(500).json({ error: 'Settings could not be saved' });
  }
});

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

function buildLoadingModal(channelId) {
  return {
    type: 'modal',
    callback_id: 'nippou_loading',
    title: { type: 'plain_text', text: '日報を作成中' },
    close: { type: 'plain_text', text: '閉じる' },
    private_metadata: JSON.stringify({ channelId }),
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: 'Toggl・カレンダーを取得し、Claudeで日報を生成しています…' },
    }],
  };
}

// --- Slash command: /nippou ---

app.command('/nippou', async (context) => {
  const { ack } = context;
  await ack();
  return continueAfterAck(handleNippouCommand(context), 'Slash command processing error');
});

async function handleNippouCommand({ command, client, body }) {
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
    const settingsUrl = `${baseUrl}/settings?token=${encodeURIComponent(settingsToken)}`;
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: `以下のリンクから設定ページを開いてください（1時間有効）:\n<${settingsUrl}|設定ページを開く>`,
    });
    return;
  }

  // --- /nippou connect-google ---
  if (subcommand === 'connect-google') {
    const authUrl = generateAuthUrl(generateGoogleState(userId, teamId));
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: `以下のリンクからGoogleカレンダーを連携してください:\n<${authUrl}|Googleアカウントを連携する>`,
    });
    return;
  }

  // --- /nippou set-daily ---
  if (subcommand === 'set-daily') {
    await saveUserData(userId, { dailyChannelId: command.channel_id }, teamId);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: `日報の投稿先を <#${command.channel_id}> に設定しました。`,
    });
    return;
  }

  // --- /nippou help ---
  if (subcommand === 'help') {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: [
        '*日報ボット - 使い方*',
        '`/nippou` - 日報を作成・送信',
        '`/nippou setup` - Toggl APIトークンを設定',
        '`/nippou settings` - Web設定ページを開く（AI・スタイル・連携）',
        '`/nippou connect-google` - Googleカレンダーを連携',
        '`/nippou set-daily` - 実行中のチャンネルを日報の投稿先に設定',
        '`/nippou help` - このヘルプを表示',
      ].join('\n'),
    });
    return;
  }

  // --- /nippou (メイン: 日報作成) ---
  const userData = await getUserData(userId, teamId);
  const targetChannelId = userData.dailyChannelId || command.channel_id;

  if (!userData.togglToken) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: '先に `/nippou setup` でToggl APIトークンを設定してください。',
    });
    return;
  }

  // Slackのtrigger_idは短時間で失効するため、外部APIを呼ぶ前にモーダルを開く。
  const loadingResult = await client.views.open({
    trigger_id: body.trigger_id,
    view: buildLoadingModal(targetChannelId),
  });

  // Fetch Toggl entries
  let todayLines = [];
  try {
    todayLines = await getTogglEntries(userData.togglToken, new Date());
    if (todayLines.length === 0) todayLines = ['・（記録なし）'];
  } catch (e) {
    console.error('Toggl error:', e.message);
    todayLines = ['・（取得失敗）'];
  }

  // Fetch Google Calendar events
  let tomorrowLines = [];
  const accounts = userData.googleAccounts || [];
  if (accounts.length > 0) {
    for (const account of accounts) {
      try {
        const events = await getCalendarEvents(account.tokens, new Date(), async (refreshed) => {
          account.tokens = refreshed;
          await saveUserData(userId, { googleAccounts: accounts }, teamId);
        });
        tomorrowLines.push(...events);
      } catch (e) {
        console.error(`Calendar error (${account.email}):`, e.message);
      }
    }
  }
  if (tomorrowLines.length === 0) tomorrowLines = ['・（予定なし）'];

  const baseDate = new Date();
  const dateLabel = formatDateLabel(baseDate);
  const tomorrowLabel = formatDateLabel(nextBusinessDay(baseDate));

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
    aiTodayLines = aiReport.todayItems;
    aiTomorrowLines = aiReport.tomorrowItems;
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
