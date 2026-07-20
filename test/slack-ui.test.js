'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_HITOKOTO_LENGTH,
  buildOnboardingMessage,
  buildReportModal,
  validateHitokoto,
} = require('../services/slack-ui');

function viewWithComment(value) {
  return {
    state: {
      values: {
        comment_block: {
          comment_input: { value },
        },
      },
    },
  };
}

test('buildOnboardingMessage explains the complete first-use flow', () => {
  const message = buildOnboardingMessage();
  const rendered = JSON.stringify(message);

  assert.match(message.text, /初期設定/);
  assert.match(rendered, /にっぽうにぎり/);
  assert.match(rendered, /Toggl/);
  assert.match(rendered, /connect-google/);
  assert.match(rendered, /set-daily/);
  assert.match(rendered, /Claude API/);
  assert.doesNotMatch(rendered, /sk-ant|xox[bp]-/);
});

test('buildReportModal keeps AI sections editable and hitokoto empty and required', () => {
  const modal = buildReportModal(
    'C123',
    ['・実装'],
    ['・定例'],
    '7月18日(土)',
    '7月21日(火)',
  );

  const commentBlock = modal.blocks.find((block) => block.block_id === 'comment_block');
  assert.equal(modal.submit.text, 'dailyへ投稿');
  assert.equal(commentBlock.optional, undefined);
  assert.equal(commentBlock.element.initial_value, undefined);
  assert.equal(commentBlock.element.min_length, 1);
  assert.equal(commentBlock.element.max_length, MAX_HITOKOTO_LENGTH);
  assert.match(commentBlock.label.text, /必須・本人入力/);
});

test('validateHitokoto rejects missing, blank, and oversized values', () => {
  assert.deepEqual(validateHitokoto({}), {
    comment: '',
    errors: { comment_block: 'ひとことは本人が入力してください。' },
  });
  assert.ok(validateHitokoto(viewWithComment(' \n ')).errors);
  assert.match(
    validateHitokoto(viewWithComment('x'.repeat(MAX_HITOKOTO_LENGTH + 1))).errors.comment_block,
    /1000文字以内/,
  );
});

test('validateHitokoto trims only surrounding whitespace and preserves multiple lines', () => {
  assert.deepEqual(validateHitokoto(viewWithComment('  一歩進みました。\n明日も続けます。  ')), {
    comment: '一歩進みました。\n明日も続けます。',
    errors: null,
  });
});
