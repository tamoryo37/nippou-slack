# Vercel本番設定

本番はVercel Functions、永続ストレージはVercel MarketplaceのNeon Postgresを使います。
Slack・Google・Notion・TogglのOAuth情報は、`NIPPOU_ENCRYPTION_KEY`によるAES-256-GCM暗号化後にDBへ保存されます。

## 1. Vercelプロジェクト

GitHubの `tamoryo37/nippou-slack` をVercelの `nippou-slack` プロジェクトへ接続します。
Framework Presetは `Express` です。`vercel.json` でもExpressを明示しています。

## 2. Neonを接続

Vercel DashboardのStorageからNeonを作成し、Production・Preview・Developmentへ接続します。
接続すると `DATABASE_URL` が自動登録されます。

## 3. 環境変数

Productionへ次を登録します。秘密値は `Sensitive` にします。

| 変数 | 内容 |
|---|---|
| `DATABASE_URL` | Neon接続時に自動登録 |
| `NIPPOU_ENCRYPTION_KEY` | `openssl rand -base64 32` の出力 |
| `SLACK_CLIENT_ID` | Slack App Basic Information |
| `SLACK_CLIENT_SECRET` | Slack App Basic Information |
| `SLACK_SIGNING_SECRET` | Slack App Basic Information |
| `SLACK_STATE_SECRET` | `openssl rand -hex 32` の出力 |
| `GOOGLE_CLIENT_ID` | Google OAuth Web Client |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Web Client |
| `GOOGLE_REDIRECT_URI` | `https://nippou-slack.vercel.app/google/callback` |
| `NOTION_CLIENT_ID` | Notion Public connection の OAuth client ID（タスク連携を使う場合） |
| `NOTION_CLIENT_SECRET` | Notion Public connection の OAuth client secret（タスク連携を使う場合） |
| `NOTION_REDIRECT_URI` | `https://nippou-slack.vercel.app/notion/callback` |
| `ANTHROPIC_API_KEY` | Anthropic Consoleで発行したキー |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` |
| `NIPPOU_AI_PROVIDER` | `api` |
| `NIPPOU_TIMEZONE` | `Asia/Tokyo` |
| `APP_URL` | `https://nippou-slack.vercel.app` |

環境変数を変更したら再デプロイが必要です。

## 4. 外部サービスのURL

このプロジェクトでは次を設定します。

| 設定先 | URL |
|---|---|
| Slack Slash Command | `https://nippou-slack.vercel.app/slack/events` |
| Slack Interactivity | `https://nippou-slack.vercel.app/slack/events` |
| Slack OAuth Redirect | `https://nippou-slack.vercel.app/slack/oauth_redirect` |
| Google OAuth Redirect | `https://nippou-slack.vercel.app/google/callback` |
| Notion OAuth Redirect | `https://nippou-slack.vercel.app/notion/callback` |
| Slack App Install | `https://nippou-slack.vercel.app/slack/install` |

URLまたはSlack scopesを変えた後は、Slack AppをWorkspaceへ再インストールします。

## 5. 動作確認

```bash
curl https://nippou-slack.vercel.app/healthz
```

`ok: true`を確認したら、Slackで以下を順に実行します。

```text
/nippou setup
/nippou connect-google
/nippou tasks
/nippou set-daily
/nippou
```
