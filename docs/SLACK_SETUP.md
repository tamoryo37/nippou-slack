# Slack設定

`nippou-slack` はSlackのスラッシュコマンドとモーダルを使います。Incoming Webhookだけでは
入力を受け取れないため、Slack Appを1つ作成し、常時到達できるHTTPS URLでこのアプリを起動します。

## 1. 公開URLを決める

Node.jsアプリの3000番ポートへ到達するHTTPS URLを用意します。

```text
https://<公開URL>
```

以降は、このURLを `https://<公開URL>` と表記します。

## 2. Slack AppをManifestから作成する

1. [Slack API - Your Apps](https://api.slack.com/apps) を開く。
2. `Create New App` → `From an app manifest` を選ぶ。
3. 対象Workspaceを選ぶ。
4. [slack-manifest.example.yaml](../slack-manifest.example.yaml) を貼り付ける。
5. ファイル内の `https://nippou-slack.example.com` を実際の公開URLへ3か所すべて置き換える。
6. 内容を確認してAppを作成する。

Manifestには次を設定済みです。

- Slash command: `/nippou`
- Request URL: `https://<公開URL>/slack/events`
- Interactivity: ON
- OAuth redirect: `https://<公開URL>/slack/oauth_redirect`
- Bot scopes: `commands`, `chat:write`
- User scope: `chat:write`

## 3. Slack認証情報を設定する

Slack Appの `Basic Information` と `OAuth & Permissions` から次を確認し、ローカルの
`.env` に設定します。値はGitHubへ登録しません。

```dotenv
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=
SLACK_STATE_SECRET=
APP_URL=https://<公開URL>
```

`SLACK_STATE_SECRET` はSlack画面から取得する値ではありません。次で個別生成します。

```bash
openssl rand -hex 32
```

## 4. Google OAuthのリダイレクト先を追加する

Google Cloud ConsoleのOAuthクライアントへ次を追加します。

```text
https://<公開URL>/google/callback
```

`.env` に同じ値とGoogleのClient ID / Client Secretを設定します。

```dotenv
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://<公開URL>/google/callback
```

## 5. 起動してWorkspaceへインストールする

```bash
npm install
npm start
```

ブラウザで次を開き、Slack Workspaceへインストールします。

```text
https://<公開URL>/slack/install
```

本人名義で投稿する各ユーザーが、それぞれこのURLからOAuthを完了します。ユーザートークンが
ない場合はボット投稿へ切り替わるため、その運用を使う場合はdailyチャンネルで
`/invite @nippou-slack` を実行してください。

## 6. Slack上で初期設定する

```text
/nippou setup
/nippou connect-google
```

dailyチャンネル内で投稿先を1回設定します。

```text
/nippou set-daily
```

以降はSlackで `/nippou` を実行します。

1. AIが「やったこと」「やること」を生成する。
2. 両欄を必要に応じて編集する。
3. 空欄の「ひとこと」を本人が入力する。
4. `dailyへ投稿` を押す。

`ひとこと` が空欄または空白だけの場合は投稿できません。

## 7. 動作確認

Slack Appの設定画面で次が一致していることを確認します。

| 項目 | 値 |
|---|---|
| Slash Command Request URL | `https://<公開URL>/slack/events` |
| Interactivity Request URL | `https://<公開URL>/slack/events` |
| OAuth Redirect URL | `https://<公開URL>/slack/oauth_redirect` |
| Google Redirect URI | `https://<公開URL>/google/callback` |

URLやScopeを変更した場合は、Slack AppをWorkspaceへ再インストールします。

公式資料:

- [Bolt for JavaScript OAuth](https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth/)
- [Slack App manifest](https://docs.slack.dev/reference/app-manifest/)
- [Slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/)
- [Modals](https://docs.slack.dev/surfaces/modals/)
