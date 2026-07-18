'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatTogglEntries } = require('../services/toggl');
const { formatCalendarEvents } = require('../services/calendar');

test('Toggl output keeps task names, removes durations, and deduplicates names', () => {
  assert.deepEqual(formatTogglEntries([
    { description: '提案書修正', duration: 3600 },
    { description: '提案書修正', duration: 1800 },
    { description: '顧客MTG', duration: 900 },
    { description: '', duration: 300 },
  ]), [
    '・提案書修正',
    '・顧客MTG',
    '・(タイトルなし)',
  ]);
});

test('Calendar output keeps event names without start times or all-day labels', () => {
  assert.deepEqual(formatCalendarEvents([
    { summary: '顧客定例', start: { dateTime: '2026-07-21T10:00:00+09:00' } },
    { summary: '資料レビュー', start: { date: '2026-07-21' } },
    { summary: '', start: { dateTime: '2026-07-21T14:00:00+09:00' } },
  ]), [
    '・顧客定例',
    '・資料レビュー',
    '・（タイトルなし）',
  ]);
});
