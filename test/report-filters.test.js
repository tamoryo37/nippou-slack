'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REPORT_FILTERS,
  filterReportLines,
  isReportTitleExcluded,
  normalizeReportFilters,
  normalizeTitleKey,
} = require('../services/report-filters');

test('report filters default to removing work locations, Busy, and 朝タスク', () => {
  assert.deepEqual(normalizeReportFilters(), {
    excludeWorkingLocations: true,
    excludeBusyEvents: true,
    excludedTitles: ['朝タスク'],
  });
  assert.equal(Object.isFrozen(DEFAULT_REPORT_FILTERS), true);
});

test('title matching normalizes bullets, NFKC, case, and whitespace', () => {
  assert.equal(normalizeTitleKey('  ・ ＡＢＣ　 Task  '), 'abc task');
  assert.equal(normalizeTitleKey('1.  朝タスク'), '朝タスク');

  const filters = normalizeReportFilters({
    excludedTitles: [' ・ ＡＢＣ　 Task ', 'abc task', '', '朝タスク'],
  });
  assert.deepEqual(filters.excludedTitles, ['ABC Task', '朝タスク']);
  assert.equal(isReportTitleExcluded('・abc   TASK', filters), true);
});

test('report line filtering uses exact matches and retains partial matches', () => {
  assert.deepEqual(filterReportLines([
    '・朝タスク',
    '・ 朝タスク ',
    '朝タスクの確認',
    '・自宅で提案書作成',
  ]), [
    '朝タスクの確認',
    '・自宅で提案書作成',
  ]);
});

test('explicit report filter settings override defaults', () => {
  const filters = normalizeReportFilters({
    excludeWorkingLocations: false,
    excludeBusyEvents: false,
    excludedTitles: [],
  });
  assert.deepEqual(filters, {
    excludeWorkingLocations: false,
    excludeBusyEvents: false,
    excludedTitles: [],
  });
  assert.equal(isReportTitleExcluded('朝タスク', filters), false);
});

test('report filter settings validate booleans, counts, and title lengths', () => {
  assert.throws(
    () => normalizeReportFilters({ excludeBusyEvents: 'true' }),
    /true または false/,
  );
  assert.throws(
    () => normalizeReportFilters({ excludedTitles: Array.from({ length: 51 }, (_, index) => `予定${index}`) }),
    /50件以内/,
  );
  assert.throws(
    () => normalizeReportFilters({ excludedTitles: ['あ'.repeat(201)] }),
    /200文字以内/,
  );
  assert.throws(
    () => normalizeReportFilters({ excludedTitles: ['予定', 123] }),
    /各項目は文字列/,
  );
});
