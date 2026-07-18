require('dotenv').config({ quiet: true });
process.env.TZ = process.env.NIPPOU_TIMEZONE || 'Asia/Tokyo';
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { App, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { getTogglEntries } = require('./services/toggl');
const { generateAuthUrl, exchangeCode, getCalendarEvents } = require('./services/calendar');
const { getUserData, saveUserData, getUserSlackToken, installationStore } = require('./services/store');
const { nextBusinessDay, formatDateLabel } = require('./services/holidays');
const { generateStructuredReport, generatePreview } = require('./services/ai');
const { buildSlackMrkdwn } = require('./services/report');
const { buildReportModal, validateHitokoto } = require('./services/slack-ui');

// --- Receiver (Express + Slack OAuth) ---

const STATE_SECRET = process.env.SLACK_STATE_SECRET;
if (!STATE_SECRET || STATE_SECRET.length < 32 || STATE_SECRET === 'nippou-slack-state-secret') {
  throw new Error('SLACK_STATE_SECRET must be a unique random string of at least 32 characters');
}

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: STATE_SECRET,
  scopes: ['commands', 'chat:write'],
  installerOptions: {
    directInstall: true,
    userScopes: ['chat:write'],
  },
  installationStore,
});

const app = new App({ receiver });

// --- Static files & settings page ---

receiver.router.use(express.static(path.join(__dirname, 'public')));

receiver.router.get('/settings', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// --- Settings token (signed URL for web UI auth) ---

const TOKEN_TTL = 3600000; // 1 hour

function generateSignedToken(purpose, userId) {
  const expires = Date.now() + TOKEN_TTL;
  const payload = `${purpose}:${userId}:${expires}`;
  const sig = crypto.createHmac('sha256', STATE_SECRET).update(payload).digest('hex');
  return `${payload}:${sig}`;
}

function verifySignedToken(token, expectedPurpose) {
  if (typeof token !== 'string') return null;
  const parts = token.split(':');
  if (parts.length !== 4) return null;
  const [purpose, userId, expires, sig] = parts;
  if (purpose !== expectedPurpose || !/^[A-Za-z][A-Za-z0-9_-]+$/.test(userId)) return null;
  if (!/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || Date.now() > expiresAt) return null;

  const expected = crypto
    .createHmac('sha256', STATE_SECRET)
    .update(`${purpose}:${userId}:${expires}`)
    .digest();
  const actual = Buffer.from(sig, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  return userId;
}

const generateSettingsToken = (userId) => generateSignedToken('settings', userId);
const verifySettingsToken = (token) => verifySignedToken(token, 'settings');
const generateGoogleState = (userId) => generateSignedToken('google', userId);
const verifyGoogleState = (token) => verifySignedToken(token, 'google');

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '');
  const userId = verifySettingsToken(token);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.slackUserId = userId;
  next();
}

// --- Settings API ---

receiver.router.get('/api/settings', authMiddleware, (req, res) => {
  const data = getUserData(req.slackUserId);
  res.json({
    togglToken: data.togglToken || '',
    ai: data.ai || {},
    googleAccounts: (data.googleAccounts || []).map((a) => ({ email: a.email })),
    googleAuthUrl: generateAuthUrl(generateGoogleState(req.slackUserId)),
  });
});

receiver.router.put('/api/settings', express.json(), authMiddleware, (req, res) => {
  const { togglToken, ai } = req.body;
  const update = {};
  if (togglToken !== undefined) update.togglToken = togglToken;
  if (ai !== undefined) update.ai = ai;
  saveUserData(req.slackUserId, update);
  res.json({ ok: true });
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
  const slackUserId = verifyGoogleState(state);
  if (!code || !slackUserId) {
    res.status(400).send('パラメータが不足しています');
    return;
  }

  try {
    const { tokens, email } = await exchangeCode(code);
    const userData = getUserData(slackUserId);
    const accounts = userData.googleAccounts || [];

    // Update or add account
    const existing = accounts.findIndex((a) => a.email === email);
    if (existing >= 0) {
      accounts[existing].tokens = tokens;
    } else {
      accounts.push({ email, tokens });
    }
    saveUserData(slackUserId, { googleAccounts: accounts });

    // Notify user via DM
    try {
      await app.client.chat.postMessage({
        channel: slackUserId,
        text: `Googleカレンダー連携完了: *${email}*\n日報に予定が自動で反映されます。`,
      });
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

app.command('/nippou', async ({ command, ack, client, body }) => {
  await ack();

  const userId = command.user_id;
  const subcommand = (command.text || '').trim();

  // --- /nippou setup ---
  if (subcommand === 'setup') {
    const userData = getUserData(userId);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: buildSetupModal(userData),
    });
    return;
  }

  // --- /nippou settings ---
  if (subcommand === 'settings') {
    const settingsToken = generateSettingsToken(userId);
    const baseUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const settingsUrl = `${baseUrl}/settings?token=${settingsToken}`;
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: `以下のリンクから設定ページを開いてください（1時間有効）:\n<${settingsUrl}|設定ページを開く>`,
    });
    return;
  }

  // --- /nippou connect-google ---
  if (subcommand === 'connect-google') {
    const authUrl = generateAuthUrl(generateGoogleState(userId));
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: userId,
      text: `以下のリンクからGoogleカレンダーを連携してください:\n<${authUrl}|Googleアカウントを連携する>`,
    });
    return;
  }

  // --- /nippou set-daily ---
  if (subcommand === 'set-daily') {
    saveUserData(userId, { dailyChannelId: command.channel_id });
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
  const userData = getUserData(userId);
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
        const events = await getCalendarEvents(account.tokens, new Date(), (refreshed) => {
          account.tokens = refreshed;
          saveUserData(userId, { googleAccounts: accounts });
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
});

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
  saveUserData(body.user.id, { togglToken });
});

// --- Modal submission: nippou ---

app.view('nippou_submit', async ({ ack, view, body, client }) => {
  const { comment, errors } = validateHitokoto(view);
  if (errors) {
    await ack({ response_action: 'errors', errors });
    return;
  }
  await ack();

  const userId = body.user.id;
  const { channelId, dateLabel, tomorrowLabel } = JSON.parse(view.private_metadata);

  const todayText = view.state.values.today_block.today_input.value;
  const tomorrowText = view.state.values.tomorrow_block.tomorrow_input.value;
  const message = buildSlackMrkdwn({
    todayItems: todayText,
    tomorrowItems: tomorrowText,
  }, { dateLabel, tomorrowLabel, comment });

  // Post as user if user token is available, otherwise fallback to bot
  const userToken = getUserSlackToken(userId);
  if (userToken) {
    const userClient = new WebClient(userToken);
    await userClient.chat.postMessage({ channel: channelId, text: message });
  } else {
    // chat:write.customizeに依存せず、通常のボット投稿へ安全にフォールバックする。
    await client.chat.postMessage({ channel: channelId, text: message });
  }
});

// --- Start ---

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`nippou-slack is running on port ${port}`);
})();
