'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseReportDateInput, resolveReportSchedule } = require('../services/report-date');

const NOW = new Date('2026-07-20T07:00:00+09:00');

test('empty input selects today in Asia/Tokyo', () => {
  const result = parseReportDateInput('', NOW);
  assert.equal(result.dateKey, '2026-07-20');
  assert.equal(result.date.toISOString(), '2026-07-20T03:00:00.000Z');
});

test('accepts ISO, slash, and Japanese full-date formats', () => {
  assert.equal(parseReportDateInput('2026-07-17', NOW).dateKey, '2026-07-17');
  assert.equal(parseReportDateInput('2026/7/17', NOW).dateKey, '2026-07-17');
  assert.equal(parseReportDateInput('2026年7月17日', NOW).dateKey, '2026-07-17');
  assert.equal(parseReportDateInput('2026年7月17日の日報', NOW).dateKey, '2026-07-17');
});

test('accepts month/day shorthand only for the current year', () => {
  assert.equal(parseReportDateInput('7/17', NOW).dateKey, '2026-07-17');
  assert.equal(parseReportDateInput('7月17日', NOW).dateKey, '2026-07-17');
  assert.throws(() => parseReportDateInput('7/21', NOW), { code: 'future_date' });
  assert.throws(
    () => parseReportDateInput('12/31', new Date('2026-01-02T08:00:00+09:00')),
    { code: 'future_date' },
  );
});

test('rejects unknown text, nonexistent dates, and explicit future dates', () => {
  assert.throws(() => parseReportDateInput('tomorrow', NOW), { code: 'invalid_format' });
  assert.throws(() => parseReportDateInput('2026-02-30', NOW), { code: 'invalid_date' });
  assert.throws(() => parseReportDateInput('2026-07-21', NOW), { code: 'future_date' });
  assert.throws(() => parseReportDateInput('2/29', NOW), { code: 'invalid_date' });
  assert.equal(parseReportDateInput('2024-02-29', NOW).dateKey, '2024-02-29');
});

test('uses Tokyo date even when now is still the previous date in UTC', () => {
  const result = parseReportDateInput('', new Date('2026-07-19T15:30:00.000Z'));
  assert.equal(result.dateKey, '2026-07-20');
});

test('resolves report and next-business-day labels as one schedule', () => {
  const result = resolveReportSchedule('2026-07-17', NOW);
  assert.deepEqual({
    dateKey: result.dateKey,
    dateLabel: result.dateLabel,
    nextBusinessDateKey: result.nextBusinessDateKey,
    nextBusinessDateLabel: result.nextBusinessDateLabel,
  }, {
    dateKey: '2026-07-17',
    dateLabel: '7月17日(金)',
    nextBusinessDateKey: '2026-07-21',
    nextBusinessDateLabel: '7月21日(火)',
  });
});
