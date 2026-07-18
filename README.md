# nippou-slack

TogglとGoogle Calendarの情報をClaudeで日報の下書きに整え、Slack上で本人が
「ひとこと」を入力してdailyチャンネルへ投稿します。カスタムGemへのコピーは不要です。

## 推奨フロー（Slack `/nippou`）

```text
Toggl + Google Calendar
          ↓
Claude Structured Outputs
   （やったこと / やること）
          ↓
Slackレビュー・モーダル
（AI部分を確認・編集 + 本人がひとことを入力）
          ↓
本人が「dailyへ投稿」を押す
```

- Claudeが「やったこと」「やること」だけをJSON Schemaに沿って生成します。
- 「ひとこと」はAIへ生成させず、毎回空欄から本人が入力します。空欄では送信できません。
- Claude生成に失敗した場合も、取得できた素材をモーダルで本人が編集できます。
- AI出力内の `@channel`、`@here`、ユーザー・ユーザーグループのメンションは通知されない表記へ変換します。

## 最短セットアップ

Node.js 20以上が必要です。

```bash
npm install
cp config/claude-instructions.example.md config/claude-instructions.md
```

高速なAnthropic API呼び出しを使う場合、`.env`へ次を設定します。

```dotenv
SLACK_DAILY_WEBHOOK_URL=https://hooks.slack.com/services/...
ANTHROPIC_API_KEY=sk-ant-...
NIPPOU_AI_PROVIDER=api
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
NIPPOU_TIMEZONE=Asia/Tokyo
NIPPOU_AI_INSTRUCTIONS_FILE=./config/claude-instructions.md
```

`NIPPOU_AI_PROVIDER=auto` は、`ANTHROPIC_API_KEY`が設定されていればAPI、
なければローカルのClaude Codeログインを使用します。API呼び出しが失敗した後に
別方式へ自動切替はしません。

`config/claude-instructions.md` へ、現在カスタムGemに設定している指示をコピーします。
お手本や文体ルールも同じファイルに含められます。

まずSlackへ送らないdry-runで確認します。

```bash
npm run cli:dry-run
```

CLIから実際に投稿する場合も、本人が書いた「ひとこと」の明示指定が必要です。

```bash
npm run cli -- --comment "本人が書いたひとこと"
```

主なオプション:

```text
--date YYYY-MM-DD  対象日を指定
--dry-run          生成・表示のみ
--comment TEXT     本人が書いたひとこと（投稿時は必須）
--force            休日または投稿済みの日を明示的に再実行
--add-account      Googleカレンダーアカウントを追加
```

## 毎日の利用

勤務終了時にSlackで次を実行します。

```text
/nippou
```

生成済みの「やったこと」「やること」を確認し、本人の「ひとこと」を入力して
`dailyへ投稿` を押します。無人cronからの自動投稿は、本人入力必須の方針とは両立しないため
通常運用には使いません。

## 開発・確認

```bash
npm test
node --check nippou.js
node --check app.js
```

Slack Appの最短設定は [docs/SLACK_SETUP.md](docs/SLACK_SETUP.md)、詳しい全体設定は
[docs/SETUP.md](docs/SETUP.md)、CLI設計と障害時の挙動は
[docs/AUTOMATION.md](docs/AUTOMATION.md) を参照してください。
