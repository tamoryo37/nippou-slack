require('dotenv').config({ quiet: true });
process.env.TZ = process.env.NIPPOU_TIMEZONE || 'Asia/Tokyo';

const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_MODEL, generateStructuredReport } = require('./services/ai');
const { formatCalendarEvents } = require('./services/calendar');
const { isBusinessDay, nextBusinessDay, formatDateLabel } = require('./services/holidays');
const { buildSlackMrkdwn } = require('./services/report');
const { filterReportLines, normalizeReportFilters } = require('./services/report-filters');
const { formatTogglEntries } = require('./services/toggl');
const { postIncomingWebhook } = require('./services/slack');
const { createPostLedger } = require('./services/post-ledger');

const TOGGL_API_TOKEN = process.env.TOGGL_API_TOKEN;

const CLIENT_SECRET_FILE = fs.readdirSync(__dirname).find((file) => file.startsWith('client_secret_'));
const TOKENS_DIR = path.join(__dirname, 'tokens');

if (!fs.existsSync(TOKENS_DIR)) fs.mkdirSync(TOKENS_DIR, { recursive: true, mode: 0o700 });

// --- Toggl ---
async function getTogglEntries(baseDate) {
  const startOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const endOfDay = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1);

  const response = await fetch(
    `https://api.track.toggl.com/api/v9/me/time_entries?start_date=${startOfDay.toISOString()}&end_date=${endOfDay.toISOString()}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${TOGGL_API_TOKEN}:api_token`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) throw new Error(`Toggl API error: ${response.status}`);

  const entries = await response.json();
  return formatTogglEntries(entries);
}

// --- Google OAuth ---
function createOAuth2Client() {
  if (!CLIENT_SECRET_FILE) {
    throw new Error('Google OAuthのclient_secret_*.jsonが見つかりません');
  }
  const credentials = JSON.parse(
    fs.readFileSync(path.join(__dirname, CLIENT_SECRET_FILE), 'utf8')
  );
  const { client_id, client_secret } = credentials.web;
  return new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3001/callback');
}

async function runOAuthFlow(oauth2Client) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
  });

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:3001');
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400);
        res.end('認証コードが取得できませんでした');
        server.close();
        return reject(new Error('No code'));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>認証完了！このタブを閉じてターミナルに戻ってください。</h2>');
      server.close();
      const { tokens } = await oauth2Client.getToken(code);
      resolve(tokens);
    });
    server.listen(3001, () => {
      console.log('\nGoogle認証が必要です。以下のURLをブラウザで開いてください：');
      console.log(authUrl);
      console.log('\nブラウザで認証するとこのターミナルが自動で続きます...\n');
    });
  });
}

async function getEmailFromToken(oauth2Client) {
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return data.email;
}

// アカウント追加
async function addAccount() {
  const oauth2Client = createOAuth2Client();
  const tokens = await runOAuthFlow(oauth2Client);
  oauth2Client.setCredentials(tokens);

  const email = await getEmailFromToken(oauth2Client);
  const tokenFile = path.join(TOKENS_DIR, `${email}.json`);
  fs.writeFileSync(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
  console.log(`\n✓ ${email} を追加しました。`);
}

// 保存済みアカウント一覧を読み込む
function loadAllAuthClients() {
  const tokenFiles = fs.readdirSync(TOKENS_DIR).filter(f => f.endsWith('.json'));
  return tokenFiles.map(file => {
    const oauth2Client = createOAuth2Client();
    const tokenPath = path.join(TOKENS_DIR, file);
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oauth2Client.setCredentials(token);
    const email = file.replace('.json', '');
    // トークンが自動更新されたらファイルに保存
    oauth2Client.on('tokens', (newTokens) => {
      const current = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const merged = { ...current, ...newTokens };
      fs.writeFileSync(tokenPath, JSON.stringify(merged), { mode: 0o600 });
    });
    return { email, client: oauth2Client };
  });
}

// --- Google Calendar ---
async function getTomorrowEvents(auth, baseDate) {
  const calendar = google.calendar({ version: 'v3', auth });
  const tomorrow = nextBusinessDay(baseDate);
  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  const end = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + 1);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return response.data.items || [];
}

async function getAllTomorrowEvents(accounts, baseDate) {
  const allEvents = [];
  for (const { email, client } of accounts) {
    try {
      const events = await getTomorrowEvents(client, baseDate);
      for (const event of events) {
        allEvents.push({ event, email });
      }
    } catch (e) {
      console.error(`${email} のカレンダー取得失敗:`, e.message);
    }
  }

  // 時刻順にソート
  allEvents.sort((a, b) => {
    const ta = a.event.start.dateTime || a.event.start.date;
    const tb = b.event.start.dateTime || b.event.start.date;
    return new Date(ta) - new Date(tb);
  });

  const lines = formatCalendarEvents(allEvents.map(({ event }) => event));

  // 同じ予定を複数の連携アカウントが参照している場合は1件にまとめる。
  return [...new Set(lines)];
}

// --- CLI utilities ---

function printUsage() {
  console.log([
    '使い方: node nippou.js [options]',
    '',
    '  --date YYYY-MM-DD  対象日を指定（省略時は今日）',
    '  --dry-run          Claudeで生成して表示するがSlackへ投稿しない',
    '  --comment TEXT     本人が書いた「ひとこと」（Slack投稿時は必須）',
    '  --force            休日・重複チェックを明示的に上書きする',
    '  --add-account      Googleカレンダーのアカウントを追加する',
    '  --help             このヘルプを表示する',
  ].join('\n'));
}

function parseArgs(argv) {
  const options = {
    addAccount: false,
    date: null,
    dryRun: false,
    force: false,
    help: false,
    comment: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--add-account') options.addAccount = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--comment') {
      options.comment = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--comment=')) {
      options.comment = arg.slice('--comment='.length);
    }
    else if (arg === '--date') {
      options.date = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--date=')) {
      options.date = arg.slice('--date='.length);
    } else {
      throw new Error(`不明なオプションです: ${arg}`);
    }
  }

  return options;
}

function parseBaseDate(dateString) {
  if (!dateString) return new Date();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    throw new Error('日付の形式が正しくありません。例: --date 2026-07-13');
  }

  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime()) || formatDateKey(date) !== dateString) {
    throw new Error('日付が正しくありません。例: --date 2026-07-13');
  }
  return date;
}

function formatDateKey(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(__dirname, value);
}

function loadAiConfig() {
  const promptParts = [];
  if (process.env.NIPPOU_AI_INSTRUCTIONS) {
    promptParts.push(process.env.NIPPOU_AI_INSTRUCTIONS.trim());
  }

  const configuredFile = process.env.NIPPOU_AI_INSTRUCTIONS_FILE;
  const defaultFile = path.join(__dirname, 'config', 'claude-instructions.md');
  const instructionFile = configuredFile
    ? resolveProjectPath(configuredFile)
    : (fs.existsSync(defaultFile) ? defaultFile : null);

  if (instructionFile) {
    if (!fs.existsSync(instructionFile)) {
      throw new Error(`Claudeの追加指示ファイルが見つかりません: ${instructionFile}`);
    }
    promptParts.push(fs.readFileSync(instructionFile, 'utf8').trim());
  }

  return {
    preset: process.env.NIPPOU_AI_PRESET || 'concise',
    customPrompt: promptParts.filter(Boolean).join('\n\n'),
    examples: [],
  };
}

function resolveSlackWebhook() {
  if (process.env.SLACK_DAILY_WEBHOOK_URL) return process.env.SLACK_DAILY_WEBHOOK_URL;
  if (process.env.SLACK_WEBHOOK_URL) {
    console.warn('注意: SLACK_WEBHOOK_URLは互換用です。daily専用のSLACK_DAILY_WEBHOOK_URLへの移行を推奨します。');
    return process.env.SLACK_WEBHOOK_URL;
  }
  throw new Error('SLACK_DAILY_WEBHOOK_URL が設定されていません');
}

function buildPostKey(baseDate, webhookUrl) {
  const webhookHash = crypto.createHash('sha256').update(webhookUrl).digest('hex').slice(0, 16);
  return `${formatDateKey(baseDate)}-${webhookHash}`;
}

function createConfiguredLedger() {
  if (!process.env.NIPPOU_POSTS_DIR) return createPostLedger();
  return createPostLedger({ postsDir: resolveProjectPath(process.env.NIPPOU_POSTS_DIR) });
}

// --- Main workflow ---

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }
  if (options.addAccount) {
    await addAccount();
    return;
  }

  if (!TOGGL_API_TOKEN) throw new Error('TOGGL_API_TOKEN が設定されていません');
  if (!options.dryRun && (!options.comment || !options.comment.trim())) {
    throw new Error('Slack投稿には本人が書いた「ひとこと」が必要です。Slackの `/nippou` を使うか、--comment を指定してください。');
  }

  const baseDate = parseBaseDate(options.date);
  if (!isBusinessDay(baseDate) && !options.force) {
    console.log(`${formatDateLabel(baseDate)} は休日のため、日報投稿をスキップしました。--force で実行できます。`);
    return;
  }

  const dateLabel = formatDateLabel(baseDate);
  const tomorrowLabel = formatDateLabel(nextBusinessDay(baseDate));
  console.log(`=== 日報作成（${dateLabel}）===\n`);
  const reportFilters = normalizeReportFilters();

  console.log('Togglからデータ取得中...');
  let togglLines;
  try {
    togglLines = filterReportLines(await getTogglEntries(baseDate), reportFilters);
    if (togglLines.length === 0) togglLines = ['・（記録なし）'];
  } catch (error) {
    console.error('Togglエラー:', error.message);
    togglLines = ['・（取得失敗）'];
  }

  const accounts = loadAllAuthClients();
  let calendarLines;
  if (accounts.length === 0) {
    console.warn('Googleアカウントが未設定です。`npm run cli -- --add-account` で追加できます。');
    calendarLines = ['・（アカウント未設定）'];
  } else {
    console.log(`Googleカレンダーからデータ取得中... (${accounts.length}アカウント)`);
    try {
      calendarLines = await getAllTomorrowEvents(accounts, baseDate);
      if (calendarLines.length === 0) calendarLines = ['・（予定なし）'];
    } catch (error) {
      console.error('Calendarエラー:', error.message);
      calendarLines = ['・（取得失敗）'];
    }
  }

  console.log('Claudeで「やったこと」「やること」を生成中...');
  // Claudeの構造化生成に失敗した場合は例外を伝播し、未整形の内容をSlackへ投稿しない。
  const generatedReport = await generateStructuredReport(
    loadAiConfig(),
    togglLines,
    calendarLines,
    dateLabel,
    tomorrowLabel,
  );
  const report = {
    todayItems: filterReportLines(generatedReport.todayItems, reportFilters),
    tomorrowItems: filterReportLines(generatedReport.tomorrowItems, reportFilters),
  };
  const comment = options.comment && options.comment.trim()
    ? options.comment.trim()
    : '（ひとことはSlackで本人が入力）';
  const message = buildSlackMrkdwn(report, { dateLabel, tomorrowLabel, comment });

  console.log(`\n${message}\n`);
  if (options.dryRun) {
    console.log('dry-run: Slackには投稿していません。');
    return;
  }

  const webhookUrl = resolveSlackWebhook();
  const ledger = createConfiguredLedger();
  const postKey = buildPostKey(baseDate, webhookUrl);
  const claimed = await ledger.claim(postKey, {
    reportDate: formatDateKey(baseDate),
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    forced: options.force,
  });

  if (!claimed && !options.force) {
    throw new Error(`この日報は投稿済み、または投稿処理中です（${formatDateKey(baseDate)}）。再投稿する場合は --force を指定してください。`);
  }

  try {
    const response = await postIncomingWebhook(webhookUrl, message);
    await ledger.markPosted(postKey, { slackStatus: response.status });
  } catch (error) {
    if (claimed) await ledger.release(postKey);
    throw error;
  }

  console.log('Slackのdailyチャンネルへ投稿しました！');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`日報処理に失敗しました: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildPostKey,
  formatDateKey,
  loadAiConfig,
  main,
  parseArgs,
  parseBaseDate,
  resolveSlackWebhook,
};
