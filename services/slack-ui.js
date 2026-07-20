'use strict';

const MAX_HITOKOTO_LENGTH = 1000;

function buildOnboardingMessage() {
  return {
    text: 'にっぽうにぎりの初期設定を始めます。セットアップ画面を開きました。',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '👋 *にっぽうにぎりへようこそ！*',
            '初回だけ、次の3ステップを設定します。',
            '_この案内はあなただけに表示されています。_',
          ].join('\n'),
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*1. Togglを設定（必須）*',
            '今開いたセットアップ画面にAPIトークンを入れて保存してください。',
            '',
            '*2. Googleカレンダーを連携（任意）*',
            '保存後に `/nippou connect-google` を実行します。やることは水曜・土日祝を除く次の営業日から取得します。',
            '',
            '*3. 投稿先を設定（推奨）*',
            '日報を投稿したいチャンネルで `/nippou set-daily` を1回実行します。',
            '',
            '準備ができたら `/nippou` で日報を作成できます。',
            '送り忘れた日は `/nippou 2026-07-17` のように日付を付けられます。',
          ].join('\n'),
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '設定はメンバーごとに個別保存されます。作業名・予定名は日報生成のためClaude APIへ送信され、投稿前に必ず確認・編集できます。',
          },
        ],
      },
    ],
  };
}

function buildReportModal(
  channelId,
  todayLines,
  tomorrowLines,
  dateLabel,
  tomorrowLabel,
  reportDateKey = '',
  nextBusinessDateKey = '',
) {
  return {
    type: 'modal',
    callback_id: 'nippou_submit',
    title: { type: 'plain_text', text: '日報を確認・送信' },
    submit: { type: 'plain_text', text: 'dailyへ投稿' },
    close: { type: 'plain_text', text: 'キャンセル' },
    private_metadata: JSON.stringify({
      channelId,
      dateLabel,
      tomorrowLabel,
      reportDateKey,
      nextBusinessDateKey,
    }),
    blocks: [
      {
        type: 'input',
        block_id: 'today_block',
        label: { type: 'plain_text', text: `やったこと（${dateLabel}）` },
        element: {
          type: 'plain_text_input',
          action_id: 'today_input',
          multiline: true,
          initial_value: todayLines.join('\n') || '・',
        },
      },
      {
        type: 'input',
        block_id: 'tomorrow_block',
        label: { type: 'plain_text', text: `やること（${tomorrowLabel}）` },
        element: {
          type: 'plain_text_input',
          action_id: 'tomorrow_input',
          multiline: true,
          initial_value: tomorrowLines.join('\n') || '・',
        },
      },
      {
        type: 'input',
        block_id: 'comment_block',
        label: { type: 'plain_text', text: 'ひとこと（必須・本人入力）' },
        hint: { type: 'plain_text', text: 'AIは生成しません。入力した内容をそのまま投稿します。' },
        element: {
          type: 'plain_text_input',
          action_id: 'comment_input',
          multiline: true,
          min_length: 1,
          max_length: MAX_HITOKOTO_LENGTH,
          placeholder: { type: 'plain_text', text: '今日感じたことや共有したいことを入力' },
        },
      },
    ],
  };
}

function validateHitokoto(view) {
  const value = view?.state?.values?.comment_block?.comment_input?.value;
  const comment = typeof value === 'string' ? value.trim() : '';

  if (!comment) {
    return {
      comment: '',
      errors: { comment_block: 'ひとことは本人が入力してください。' },
    };
  }
  if (comment.length > MAX_HITOKOTO_LENGTH) {
    return {
      comment: '',
      errors: { comment_block: `ひとことは${MAX_HITOKOTO_LENGTH}文字以内で入力してください。` },
    };
  }

  return { comment, errors: null };
}

module.exports = {
  MAX_HITOKOTO_LENGTH,
  buildOnboardingMessage,
  buildReportModal,
  validateHitokoto,
};
