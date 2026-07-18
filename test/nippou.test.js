const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TZ = 'Asia/Tokyo';

const {
  buildPostKey,
  formatDateKey,
  parseArgs,
  parseBaseDate,
} = require('../nippou');

test('parseArgs supports safe daily-run options', () => {
  assert.deepEqual(parseArgs(['--date=2026-07-13', '--dry-run', '--force']), {
    addAccount: false,
    date: '2026-07-13',
    dryRun: true,
    force: true,
    help: false,
    comment: null,
  });
  assert.deepEqual(parseArgs(['--date', '2026-07-14', '--add-account']), {
    addAccount: true,
    date: '2026-07-14',
    dryRun: false,
    force: false,
    help: false,
    comment: null,
  });
  assert.deepEqual(parseArgs(['--comment', '本人のひとこと']), {
    addAccount: false,
    date: null,
    dryRun: false,
    force: false,
    help: false,
    comment: '本人のひとこと',
  });
  assert.throws(() => parseArgs(['--unknown']), /不明なオプション/);
});

test('parseBaseDate validates ISO dates in Asia/Tokyo', () => {
  const date = parseBaseDate('2026-07-13');
  assert.equal(formatDateKey(date), '2026-07-13');
  assert.throws(() => parseBaseDate('2026/07/13'), /形式が正しくありません/);
  assert.throws(() => parseBaseDate('2026-02-30'), /日付が正しくありません/);
});

test('buildPostKey is stable per date and destination without exposing the webhook', () => {
  const date = parseBaseDate('2026-07-13');
  const webhook = 'https://hooks.slack.com/services/SECRET/DESTINATION';
  const key = buildPostKey(date, webhook);

  assert.match(key, /^2026-07-13-[a-f0-9]{16}$/);
  assert.equal(key, buildPostKey(date, webhook));
  assert.doesNotMatch(key, /SECRET|DESTINATION/);
  assert.notEqual(key, buildPostKey(date, `${webhook}-other`));
});
