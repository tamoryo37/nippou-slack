const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'Asia/Tokyo';

const {
  isBusinessDay,
  nextBusinessDateKey,
  nextBusinessDay,
  toBusinessDateKey,
} = require('../services/holidays');

test('uses the configured business timezone when UTC is on a different date', () => {
  assert.equal(toBusinessDateKey(new Date('2026-07-14T16:30:00.000Z')), '2026-07-15');
  assert.equal(nextBusinessDateKey(new Date('2026-07-14T16:30:00.000Z')), '2026-07-16');
});

test('Wednesday, weekends, and Japanese public holidays are closed', () => {
  assert.equal(isBusinessDay('2026-07-14'), true); // 火曜
  assert.equal(isBusinessDay('2026-07-15'), false); // 水曜
  assert.equal(isBusinessDay('2026-07-18'), false); // 土曜
  assert.equal(isBusinessDay('2026-07-19'), false); // 日曜
  assert.equal(isBusinessDay('2026-07-20'), false); // 海の日
});

test('Tuesday report uses Thursday as the next business day', () => {
  assert.equal(nextBusinessDateKey('2026-07-14'), '2026-07-16');
});

test('skips weekends, holidays, substitute holidays, and citizens holidays', () => {
  assert.equal(nextBusinessDateKey('2026-07-10'), '2026-07-13');
  assert.equal(nextBusinessDateKey('2026-07-17'), '2026-07-21');
  assert.equal(nextBusinessDateKey('2027-03-19'), '2027-03-23');
  assert.equal(nextBusinessDateKey('2026-09-18'), '2026-09-24');
});

test('crosses a year boundary without mutating the input', () => {
  const reportDate = new Date('2026-12-31T12:34:56+09:00');
  const originalTime = reportDate.getTime();

  assert.equal(nextBusinessDateKey(reportDate), '2027-01-04');
  assert.equal(nextBusinessDay(reportDate).toISOString(), '2027-01-04T03:00:00.000Z');
  assert.equal(reportDate.getTime(), originalTime);
});

test('rejects invalid dates and years outside the holiday dataset', () => {
  assert.throws(() => nextBusinessDateKey('2026-02-30'), /存在しない日付/);
  assert.throws(() => isBusinessDay('1969-12-31'), /1970年から2050年/);
  assert.throws(() => isBusinessDay('2051-01-01'), /1970年から2050年/);
});
