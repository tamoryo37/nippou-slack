'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_SLACK_TEXT_LENGTH,
  buildSlackMrkdwn,
  neutralizeSlackMentions,
  normalizeReport,
} = require('../services/report');

test('normalizeReport accepts integration aliases and normalizes bullets', () => {
  assert.deepEqual(
    normalizeReport({
      date: ' 7月13日（月） ',
      nextDateLabel: '7月14日（火）',
      todayItems: ['・ 顧客ヒアリング', '- 実装\n* レビュー'],
      tomorrowItems: '1. 提案書を更新\n\n・ 定例会',
      oneLiner: '  良い進捗でした。 ',
    }),
    {
      dateLabel: '7月13日（月）',
      tomorrowLabel: '7月14日（火）',
      did: ['顧客ヒアリング', '実装', 'レビュー'],
      will: ['提案書を更新', '定例会'],
      comment: '良い進捗でした。',
    }
  );
});

test('normalizeReport rejects malformed sections and accepts empty work days', () => {
  assert.throws(() => normalizeReport(null), /plain object/);
  assert.throws(() => normalizeReport({ did: ['ok'] }), /report\.will is required/);
  assert.throws(
    () => normalizeReport({ did: ['ok', 42], will: ['next'] }),
    /report\.did\[1\] must be a string/
  );
  assert.deepEqual(normalizeReport({ did: ['  '], will: [] }), {
    dateLabel: '',
    tomorrowLabel: '',
    did: [],
    will: [],
    comment: '',
  });
});

test('neutralizeSlackMentions blocks notification markup and preserves links', () => {
  const input = [
    '<@U012ABCDEF>',
    '<!subteam^S012ABCDEF|@developers>',
    '<!channel>',
    '<!here>',
    '<!everyone>',
    '<https://example.com/path?q=1|仕様書>',
    '<mailto:daily@example.com|daily@example.com>',
  ].join(' ');

  assert.equal(
    neutralizeSlackMentions(input),
    [
      '＜@U012ABCDEF＞',
      '＜!subteam^S012ABCDEF|@developers＞',
      '＜!channel＞',
      '＜!here＞',
      '＜!everyone＞',
      '<https://example.com/path?q=1|仕様書>',
      '<mailto:daily@example.com|daily@example.com>',
    ].join(' ')
  );
});

test('buildSlackMrkdwn emits stable headings, safe items, and optional comment', () => {
  const message = buildSlackMrkdwn({
    dateLabel: '7月13日（月）',
    tomorrowLabel: '7月14日（火）',
    did: ['設計 <@U123ABC>', '資料 <https://example.com|リンク>'],
    will: ['実装'],
    comment: '<!here> 今日もお疲れさまでした。',
  });

  assert.equal(
    message,
    [
      '*日報 7月13日（月）*',
      '',
      '*やったこと*',
      '・設計 ＜@U123ABC＞',
      '・資料 <https://example.com|リンク>',
      '',
      '*やること（7月14日（火））*',
      '・実装',
      '',
      '*ひとこと*',
      '＜!here＞ 今日もお疲れさまでした。',
    ].join('\n')
  );

  assert.doesNotMatch(buildSlackMrkdwn({ did: ['完了'], will: ['継続'] }), /ひとこと/);
});

test('buildSlackMrkdwn can add delivery labels without mutating AI output', () => {
  const report = { todayItems: ['完了'], tomorrowItems: ['継続'] };
  const message = buildSlackMrkdwn(report, {
    dateLabel: '2026-07-13',
    tomorrowLabel: '2026-07-14',
    comment: '順調です',
  });

  assert.match(message, /^\*日報 2026-07-13\*/);
  assert.match(message, /\*やること（2026-07-14）\*/);
  assert.match(message, /\*ひとこと\*\n順調です$/);
  assert.deepEqual(report, { todayItems: ['完了'], tomorrowItems: ['継続'] });
});

test('buildSlackMrkdwn supplies explicit empty-state items', () => {
  const message = buildSlackMrkdwn({ todayItems: [], tomorrowItems: [], comment: '' });

  assert.match(message, /\*やったこと\*\n・（記録なし）/);
  assert.match(message, /\*やること\*\n・（予定なし）/);
});

test('buildSlackMrkdwn rejects an oversized Slack payload', () => {
  assert.throws(
    () => buildSlackMrkdwn({ did: ['x'.repeat(MAX_SLACK_TEXT_LENGTH)], will: ['next'] }),
    /Slack message exceeds/
  );
});
