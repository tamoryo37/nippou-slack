# 日報自動化の設計

## 目的

従来は、CLIがTogglとGoogle Calendarから作った素材をSlackへ投稿し、人がその素材をカスタムGemへコピーして整形結果をdailyチャンネルへ戻していました。

今回の実装では、素材がSlackへ出る前にClaudeへ渡し、「やったこと」「やること」の下書きを作ります。「ひとこと」はClaudeに渡さず、本人がSlackモーダルまたはCLIの `--comment` で入力します。

## 処理順序

1. `nippou.js` が対象日をAsia/Tokyoで確定する。
2. 土日・日本の祝日なら、`--force` がない限り終了する。
3. Togglから当日の作業、Google Calendarから次の営業日の予定を取得する。
4. `services/ai.js` がClaudeへ未信頼データとして渡す。
5. Claude Structured Outputsで `todayItems`、`tomorrowItems` を得る。
6. `services/report.js` が本人入力の `comment` と結合してSlack mrkdwnを組み立て、意図しないメンションと長すぎる投稿を拒否する。
7. `services/post-ledger.js` が対象日とWebhookの組み合わせを原子的に予約する。
8. `services/slack.js` がIncoming Webhookへ最終形を投稿する。
9. 成功を `store/posts/` に記録する。Webhook失敗時は予約を解放し、次回再試行できるようにする。

## Claudeの設定

カスタムGemそのものを呼ぶのではなく、Gemで使っていた指示をClaudeのsystem promptへ追加します。

設定方法:

```bash
cp config/claude-instructions.example.md config/claude-instructions.md
```

Claude Codeへログイン済みのローカルMacでは、APIキーなしで非対話モードを使用できます。
APIキーがある環境では従来どおりAnthropic APIを使用できます。

`.env`:

```dotenv
NIPPOU_AI_PROVIDER=api
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
CLAUDE_CODE_MODEL=claude-sonnet-4-6
NIPPOU_CLAUDE_CLI_PATH=/Users/ryo/.local/bin/claude
CLAUDE_CLI_TIMEOUT_MS=120000
NIPPOU_AI_PRESET=concise
NIPPOU_AI_INSTRUCTIONS_FILE=./config/claude-instructions.md
```

プロバイダーの動作:

- `auto`: APIキーがあればAnthropic API、なければローカルClaude Code
- `api`: Anthropic APIを明示使用
- `claude-cli`: ローカルClaude Codeを明示使用

ローカルCLI実行時は、ツール、MCP、Chrome、スラッシュコマンド、セッション保存を無効化し、
Slack・Toggl・Googleの秘密情報を子プロセスへ渡しません。system promptは一時的な`0600`
ファイル、日報素材は標準入力で渡します。

`config/claude-instructions.md` は `.gitignore` 対象です。環境変数 `NIPPOU_AI_INSTRUCTIONS` へ直接書くこともでき、ファイル指定と併用した場合は両方が追加されます。

## 投稿先

`SLACK_DAILY_WEBHOOK_URL` にはdailyチャンネル用のIncoming Webhookを設定します。旧 `SLACK_WEBHOOK_URL` も互換用に使えますが、誤投稿を避けるためdaily専用変数への移行を推奨します。

Webhook URLは投稿先チャンネルに紐づく秘密情報です。リポジトリへコミットせず、`.env` またはシークレット管理サービスに保存します。

## 安全側の失敗

- Claude APIの拒否、タイムアウト、構造化結果の欠落: Slackへ投稿しない。
- Slack Webhookの失敗: エラー終了し、投稿予約を解放する。
- 同日・同一送信先の再実行: 投稿せずエラー終了する。
- 取得元の一部失敗: 「取得失敗」を入力に含め、残りの情報で生成を続ける。
- `@channel`、`@here`、`@everyone`、ユーザー・ユーザーグループのSlack記法: 全角括弧へ変換し通知を防ぐ。
- 38,000文字を超える投稿: Slackへ送る前に拒否する。
- URLの自動展開: Webhook payloadで無効化する。

## 再投稿と確認

投稿せず確認:

```bash
npm run cli -- --dry-run
```

本人の「ひとこと」を含めて投稿:

```bash
npm run cli -- --comment "本人が書いたひとこと"
```

過去日を確認:

```bash
npm run cli -- --date 2026-07-13 --dry-run
```

休日または投稿済みの日を意図的に再投稿:

```bash
npm run cli -- --date 2026-07-13 --force --comment "本人が書いたひとこと"
```

`--force` は実際に重複投稿し得るため、内容と送信先を確認してから使います。

## 運用上の注意

- `store/posts/` は単一Mac上のCLI実行を想定したファイル台帳です。複数サーバーから実行する場合は、SQLiteやPostgreSQLの一意制約へ置き換えてください。
- 本人の「ひとこと」が必須なので、無人cronからの最終投稿は行いません。定刻通知が必要な場合はSlack DMの「日報を書く」ボタンからモーダルを開く方式にします。
- APIキー、Webhook、Google OAuthトークンは平文ファイルへ保存されるため、ファイル権限を `0600` にし、共有・バックアップ先も確認してください。
- 業務情報を外部AIへ送るため、組織のAnthropic利用ルールとデータ保持条件を確認してください。
- ローカルClaude Code認証は、同じmacOSユーザーかつログインキーチェーンが利用できる状態で実行してください。ログアウト状態のバックグラウンド実行にはAPIキー方式を使います。
- 本番投稿前に `npm test` と `npm run cli:dry-run` を実行してください。
