const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'Asia/Tokyo';

const { isBusinessDay, nextBusinessDay } = require('../services/holidays');

test('isBusinessDay rejects weekends and Japanese public holidays', () => {
  assert.equal(isBusinessDay(new Date('2026-07-11T12:00:00+09:00')), false);
  assert.equal(isBusinessDay(new Date('2026-07-13T12:00:00+09:00')), true);
  assert.equal(isBusinessDay(new Date('2026-07-20T12:00:00+09:00')), false);
});

test('nextBusinessDay skips weekends and Japanese public holidays', () => {
  const next = nextBusinessDay(new Date('2026-07-17T12:00:00+09:00'));
  assert.equal(next.toISOString(), '2026-07-21T03:00:00.000Z');
  assert.equal(nextBusinessDay(next).toISOString(), '2026-07-22T03:00:00.000Z');
});
