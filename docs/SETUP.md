# nippou-slack セットアップガイド

Slack 上で日報を作成・送信できるボットです。
Toggl の作業記録と Google カレンダーの予定を自動取得し、編集してから投稿できます。

---

## 目次

1. [アーキテクチャ概要](#アーキテクチャ概要)
2. [Slack App の作成](#slack-app-の作成)
3. [Google OAuth の設定](#google-oauth-の設定)
4. [環境変数の設定](#環境変数の設定)
5. [起動](#起動)
6. [チームメンバーの初期設定](#チームメンバーの初期設定)
7. [コマンド一覧](#コマンド一覧)
8. [ファイル構成](#ファイル構成)

---

## アーキテクチャ概要

```
メンバー                   nippou-slack                    外部サービス
───────                    ──────────                     ────────────
  │                             │                              │
  │  /nippou                    │                              │
  ├────────────────────────────>│  Toggl API ─────────────────>│
  │                             │  Google Calendar API ───────>│
  │  モーダル表示(編集可)        │                              │
  │<────────────────────────────┤                              │
  │                             │                              │
  │  [送信] クリック             │                              │
  ├────────────────────────────>│                              │
  │                             │  chat.postMessage            │
  │  ユーザー本人として投稿      │  (ユーザーの OAuth トークン)   │
  │<────────────────────────────┤──────────────────────────────>│
```

**ポイント**: Slack OAuth でユーザートークン (`xoxp-`) を取得するため、
メッセージはボットではなく本人が投稿した形で表示されます。

---

## Slack App の作成

### 1. アプリを作成

1. [Slack API: Your Apps](https://api.slack.com/apps) にアクセス
2. **Create New App** > **From scratch** を選択
3. App Name: `にっぽうにぎり`、Workspace を選択して作成

### 2. OAuth & Permissions

**Bot Token Scopes** に以下を追加:

| Scope | 用途 |
|-------|------|
| `commands` | スラッシュコマンド |
| `chat:write` | ボットとしてメッセージ送信（フォールバック用） |

**User Token Scopes** に以下を追加:

| Scope | 用途 |
|-------|------|
| `chat:write` | ユーザー本人としてメッセージ送信 |

### 3. Redirect URLs

OAuth の **Redirect URLs** に以下を追加:

```
https://<your-domain>/slack/oauth_redirect
```

ローカル開発時は ngrok 等を使い、そのURLを設定します。

### 4. Slash Commands

**Slash Commands** で以下を作成:

| Command | Request URL | Description |
|---------|-------------|-------------|
| `/nippou` | `https://<your-domain>/slack/events` | 日報を作成・送信 |

### 5. Interactivity

**Interactivity & Shortcuts** を ON にし、Request URL を設定:

```
https://<your-domain>/slack/events
```

### 6. 認証情報を控える

**Basic Information** ページから以下を控えておく:

- **Client ID** → `SLACK_CLIENT_ID`
- **Client Secret** → `SLACK_CLIENT_SECRET`
- **Signing Secret** → `SLACK_SIGNING_SECRET`

---

## Google OAuth の設定

### 1. Google Cloud Console

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを選択
2. **APIs & Services** > **Credentials** へ移動
3. OAuth 2.0 クライアント ID を作成（Web application）
4. **Authorized redirect URIs** に以下を追加:

```
https://<your-domain>/google/callback
```

### 2. 認証情報を控える

- **Client ID** → `GOOGLE_CLIENT_ID`
- **Client Secret** → `GOOGLE_CLIENT_SECRET`

### 3. Calendar API を有効化

**APIs & Services** > **Library** で「Google Calendar API」を検索し、有効化します。

---

## 環境変数の設定

`.env.example` をコピーして `.env` を作成し、値を埋めます。

```bash
cp .env.example .env
```

`SLACK_STATE_SECRET` は共有の既定値を使わず、次のように個別生成してください。

```bash
openssl rand -hex 32
```

| 変数 | 説明 |
|------|------|
| `SLACK_CLIENT_ID` | Slack App の Client ID |
| `SLACK_CLIENT_SECRET` | Slack App の Client Secret |
| `SLACK_SIGNING_SECRET` | Slack App の Signing Secret |
| `SLACK_STATE_SECRET` | OAuth state・設定URL署名用の十分に長いランダム文字列 |
| `SLACK_DAILY_WEBHOOK_URL` | CLI版の最終投稿先となるdailyチャンネルのIncoming Webhook |
| `GOOGLE_CLIENT_ID` | Google OAuth の Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth の Client Secret |
| `GOOGLE_REDIRECT_URI` | Google OAuth コールバック URL |
| `NOTION_CLIENT_ID` | Notion Public connection の OAuth client ID（任意） |
| `NOTION_CLIENT_SECRET` | Notion Public connection の OAuth client secret（任意） |
| `NOTION_REDIRECT_URI` | Notion OAuth コールバック URL |
| `NIPPOU_AI_PROVIDER` | `auto` / `api` / `claude-cli`（デフォルト: `auto`） |
| `ANTHROPIC_API_KEY` | Anthropic API利用時のキー。ローカルClaude Code利用時は不要 |
| `ANTHROPIC_MODEL` | Claude APIモデル（デフォルト: `claude-haiku-4-5-20251001`） |
| `CLAUDE_CODE_MODEL` | ローカルClaude Codeで使うモデル |
| `NIPPOU_CLAUDE_CLI_PATH` | `claude`実行ファイルのパス |
| `NIPPOU_AI_INSTRUCTIONS_FILE` | カスタム指示ファイルへのパス |
| `NIPPOU_TIMEZONE` | 日報の日付判定タイムゾーン（デフォルト: `Asia/Tokyo`） |
| `PORT` | サーバーポート（デフォルト: 3000） |
| `APP_URL` | アプリの公開URL（設定ページのリンク生成に使用） |

---

## 起動

### 依存関係のインストール

```bash
npm install
```

### アプリの起動

```bash
npm start
```

### ローカル開発（ngrok）

```bash
# 別ターミナルで
ngrok http 3000
```

表示された `https://xxxx.ngrok.io` を Slack App の各 URL に設定します。

---

## チームメンバーの初期設定

各メンバーが行う作業は以下の **6ステップ** です。

### Step 1: アプリを認証

管理者が共有するインストール URL (`https://<your-domain>/slack/install`) にアクセスし、
Slack の OAuth 画面で **Allow** をクリックします。

これにより、ユーザートークンが取得され、本人として投稿できるようになります。

### Step 2: Toggl を設定

Slack で以下を実行:

```
/nippou setup
```

モーダルが開くので、[Toggl Profile](https://track.toggl.com/profile) ページ下部にある
API トークンを入力して保存します。

### Step 3: Google カレンダーを連携（任意）

```
/nippou connect-google
```

表示されるリンクをクリックし、Google アカウントを認証します。
複数のアカウントを連携したい場合は、このコマンドを繰り返し実行します。

設定ページの「日報に載せない予定・タスク」では、勤務場所イベントと `Busy` の自動除外を
切り替えられます。また、`朝タスク` など除外したいタイトルを1行ずつ完全一致で
登録できます。「取得内容をテスト」で、次の営業日に含まれる予定と除外される予定を
保存前に確認できます。タイトルの除外設定はToggl・Notion・JSONのタスクにも共通で
適用されます。

### Step 4: タスク管理を連携（任意）

```text
/nippou tasks
```

Notionの場合は本人がOAuth画面でタスクDBまたは親ページを許可し、設定画面に
データベースURLを貼ります。その他のツールは共通形式のHTTPS JSONフィードを設定します。
個人タスクや `vault参照のみ` のタスクは取得対象外です。

### Step 5: AI書き方設定（任意）

```
/nippou settings
```

表示されるリンクをクリックすると、ブラウザで設定ページが開きます。

- **書き方スタイル** — 簡潔/丁寧/所感ありの3プリセットから選択
- **カスタム指示** — AIへの追加の指示を自由記述
- **お手本の日報** — 理想の日報を1〜3個登録すると、書き方を精度高く再現
- **プレビュー** — 現在の設定でAIが生成する日報のサンプルを確認

設定はすべて Web UI 上で完結し、Toggl・Google カレンダーの連携もここから行えます。

### Step 6: dailyチャンネルを投稿先に設定

dailyチャンネル内で次を一度実行します。

```text
/nippou set-daily
```

---

## コマンド一覧

| コマンド | 説明 |
|---------|------|
| `/nippou` | 日報モーダルを開く（Toggl + Calendar + Tasks データをプリフィル） |
| `/nippou 2026-07-17` | 指定日の日報モーダルを開く（`7/17`・`7月17日`も可） |
| `/nippou setup` | Toggl API トークンを設定（Slack モーダル） |
| `/nippou settings` | Web 設定ページを開く（AI・スタイル・連携） |
| `/nippou tasks` | Notion・JSONタスク連携を設定（任意） |
| `/nippou connect-google` | Google カレンダーアカウントを連携 |
| `/nippou set-daily` | 実行中のチャンネルを日報の投稿先に設定 |
| `/nippou help` | ヘルプを表示 |

---

## ファイル構成

```
nippou-slack/
├── app.js                 # Slack Bolt メインアプリ
├── nippou.js              # CLI 版（従来のスタンドアロン版）
├── services/
│   ├── ai.js              # Claude API (AI日報生成)
│   ├── report.js          # Slack投稿文の整形・メンション抑止
│   ├── slack.js           # Incoming Webhook送信
│   ├── post-ledger.js     # 同日重複投稿の防止
│   ├── holidays.js        # 営業日計算・祝日判定
│   ├── toggl.js           # Toggl API クライアント
│   ├── calendar.js        # Google Calendar API クライアント
│   ├── tasks.js           # Notion OAuth/API・共通JSONタスク連携
│   └── store.js           # ファイルベースのデータストア
├── config/
│   └── claude-instructions.example.md # カスタム指示の雛形
├── public/
│   ├── settings.html      # Web設定ページ
│   ├── style.css          # スタイルシート
│   └── settings.js        # フロントエンド JS
├── store/                 # ユーザーデータ保存先（.gitignore 対象）
│   ├── users/             #   各ユーザーの設定 (Toggl, AI設定等)
│   └── installations/     #   Slack OAuth インストール情報
├── docs/
│   ├── SETUP.md           # Slack App版セットアップ
│   └── AUTOMATION.md      # CLI自動化の設計と運用
├── test/                  # 外部送信を行わない自動テスト
├── .env                   # 環境変数（.gitignore 対象）
├── .env.example           # 環境変数テンプレート
└── package.json
```

---

## 旧 CLI 版との関係

`nippou.js`（CLI版）は、Toggl・Google Calendarの素材をClaudeで整形し、
「やったこと」「やること」を生成します。Slackへ投稿する場合は、本人が書いた
「ひとこと」を `--comment` で明示する必要があります。

```bash
# CLI版の実行
npm run cli -- --comment "本人が書いたひとこと"
npm run cli -- --date=2026-04-14 --comment "本人が書いたひとこと"
npm run cli -- --dry-run
```

Slack App 版 (`app.js`) はチーム全員が使うことを想定した新しいインターフェースです。
CLI版のAI・投稿先・重複防止の設定は [AUTOMATION.md](./AUTOMATION.md) を参照してください。
