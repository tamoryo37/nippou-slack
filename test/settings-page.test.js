'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('settings page exposes report exclusions and calendar retrieval test', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'settings.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'public', 'settings.js'), 'utf8');

  for (const id of [
    'excludeWorkingLocations',
    'excludeBusyEvents',
    'excludedTitles',
    'calendarTestBtn',
    'calendarTestResult',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(script, new RegExp(`getElementById\\(["']${id}["']\\)`));
  }

  assert.match(script, /reportFilters:\s*getReportFiltersBody\(\)/);
  assert.match(script, /fetch\(['"]\/api\/calendar\/test['"]/);
});
