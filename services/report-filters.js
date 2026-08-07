'use strict';

const MAX_EXCLUDED_TITLES = 50;
const MAX_EXCLUDED_TITLE_LENGTH = 200;

const DEFAULT_REPORT_FILTERS = Object.freeze({
  excludeWorkingLocations: true,
  excludeBusyEvents: true,
  excludedTitles: Object.freeze(['朝タスク']),
});

function stripBulletPrefix(value) {
  return value.replace(/^\s*(?:[・•●◦▪▫‣⁃*-]|\d+[.)])\s*/, '');
}

function normalizeTitleDisplay(value) {
  return stripBulletPrefix(value.normalize('NFKC'))
    .trim()
    .replace(/\s+/gu, ' ');
}

function normalizeTitleKey(value) {
  if (value === undefined || value === null) return '';
  return normalizeTitleDisplay(String(value)).toLowerCase();
}

function normalizeBoolean(value, fallback, fieldName) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new TypeError(`${fieldName} は true または false で指定してください。`);
  }
  return value;
}

function normalizeExcludedTitles(value) {
  if (value === undefined) return [...DEFAULT_REPORT_FILTERS.excludedTitles];

  const entries = typeof value === 'string'
    ? value.split(/\r?\n/u)
    : value;

  if (!Array.isArray(entries)) {
    throw new TypeError('excludedTitles は文字列の配列または改行区切りの文字列で指定してください。');
  }

  const titles = [];
  const seen = new Set();

  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new TypeError('excludedTitles の各項目は文字列で指定してください。');
    }

    const title = normalizeTitleDisplay(entry);
    if (!title) continue;
    if (title.length > MAX_EXCLUDED_TITLE_LENGTH) {
      throw new RangeError(`除外タイトルは1件${MAX_EXCLUDED_TITLE_LENGTH}文字以内で指定してください。`);
    }

    const key = normalizeTitleKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }

  if (titles.length > MAX_EXCLUDED_TITLES) {
    throw new RangeError(`除外タイトルは${MAX_EXCLUDED_TITLES}件以内で指定してください。`);
  }

  return titles;
}

function normalizeReportFilters(value) {
  if (value === undefined || value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('reportFilters はオブジェクトで指定してください。');
  }

  return {
    excludeWorkingLocations: normalizeBoolean(
      value.excludeWorkingLocations,
      DEFAULT_REPORT_FILTERS.excludeWorkingLocations,
      'excludeWorkingLocations',
    ),
    excludeBusyEvents: normalizeBoolean(
      value.excludeBusyEvents,
      DEFAULT_REPORT_FILTERS.excludeBusyEvents,
      'excludeBusyEvents',
    ),
    excludedTitles: normalizeExcludedTitles(value.excludedTitles),
  };
}

function isReportTitleExcluded(value, reportFilters) {
  const filters = normalizeReportFilters(reportFilters);
  const titleKey = normalizeTitleKey(value);
  if (!titleKey) return false;

  return filters.excludedTitles.some((title) => normalizeTitleKey(title) === titleKey);
}

function filterReportLines(lines, reportFilters) {
  if (!Array.isArray(lines)) return [];
  const filters = normalizeReportFilters(reportFilters);
  const excludedTitleKeys = new Set(filters.excludedTitles.map(normalizeTitleKey));

  return lines.filter((line) => !excludedTitleKeys.has(normalizeTitleKey(line)));
}

module.exports = {
  DEFAULT_REPORT_FILTERS,
  MAX_EXCLUDED_TITLES,
  MAX_EXCLUDED_TITLE_LENGTH,
  filterReportLines,
  isReportTitleExcluded,
  normalizeReportFilters,
  normalizeTitleKey,
};
