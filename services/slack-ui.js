'use strict';

const MAX_HITOKOTO_LENGTH = 1000;

function buildReportModal(channelId, todayLines, tomorrowLines, dateLabel, tomorrowLabel) {
  return {
    type: 'modal',
    callback_id: 'nippou_submit',
    title: { type: 'plain_text', text: '日報を確認・送信' },
    submit: { type: 'plain_text', text: 'dailyへ投稿' },
    close: { type: 'plain_text', text: 'キャンセル' },
    private_metadata: JSON.stringify({ channelId, dateLabel, tomorrowLabel }),
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
  buildReportModal,
  validateHitokoto,
};
