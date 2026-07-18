'use strict';

const ITEM_ALIASES = {
  did: ['did', 'todayItems', 'done', 'today', 'completed', 'accomplishments', 'やったこと'],
  will: ['will', 'tomorrowItems', 'next', 'tomorrow', 'planned', 'plans', 'やること'],
};

const LABEL_ALIASES = {
  dateLabel: ['dateLabel', 'date_label', 'date'],
  tomorrowLabel: ['tomorrowLabel', 'tomorrow_label', 'nextDateLabel', 'next_date_label'],
  comment: ['comment', 'oneLiner', 'oneLine', 'one_liner', 'hitokoto', 'ひとこと'],
};

const BULLET_PREFIX = /^(?:(?:[-*+•・]️?\s*)|(?:\d+[.)]\s+))/;
const MAX_SLACK_TEXT_LENGTH = 38000;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readAlias(source, aliases) {
  for (const key of aliases) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function cleanText(value) {
  return value.replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
}

function normalizeItems(value, fieldName) {
  if (value === undefined) {
    throw new TypeError(`report.${fieldName} is required`);
  }

  const values = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(values)) {
    throw new TypeError(`report.${fieldName} must be a string or an array of strings`);
  }

  const items = [];
  values.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      throw new TypeError(`report.${fieldName}[${index}] must be a string`);
    }

    for (const line of cleanText(entry).split('\n')) {
      const normalized = line.trim().replace(BULLET_PREFIX, '').trim();
      if (normalized) items.push(normalized);
    }
  });

  return items;
}

function normalizeLabel(value, fieldName) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new TypeError(`report.${fieldName} must be a string`);
  }

  const normalized = cleanText(value);
  if (normalized.includes('\n')) {
    throw new TypeError(`report.${fieldName} must be a single line`);
  }
  return normalized;
}

function normalizeComment(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    throw new TypeError('report.comment must be a string');
  }
  return cleanText(value);
}

/**
 * Convert accepted AI/report shapes into one stable representation.
 *
 * Canonical output:
 *   { dateLabel, tomorrowLabel, did: string[], will: string[], comment }
 */
function normalizeReport(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('report must be a plain object');
  }

  return {
    dateLabel: normalizeLabel(readAlias(input, LABEL_ALIASES.dateLabel), 'dateLabel'),
    tomorrowLabel: normalizeLabel(
      readAlias(input, LABEL_ALIASES.tomorrowLabel),
      'tomorrowLabel'
    ),
    did: normalizeItems(readAlias(input, ITEM_ALIASES.did), 'did'),
    will: normalizeItems(readAlias(input, ITEM_ALIASES.will), 'will'),
    comment: normalizeComment(readAlias(input, LABEL_ALIASES.comment)),
  };
}

/**
 * Slack resolves these angle-bracket tokens into notifications. Full-width
 * brackets keep the text readable without allowing AI/user input to notify a
 * person, user group, or an entire channel. Slack link tokens are untouched.
 */
function neutralizeSlackMentions(value) {
  if (typeof value !== 'string') {
    throw new TypeError('text must be a string');
  }

  return value.replace(
    /<@[A-Z0-9][^>\s]*>|<!subteam\^[^>|\s]+(?:\|[^>\r\n]*)?>|<!(?:channel|everyone|here)(?:\|[^>\r\n]*)?>/gi,
    (mention) => `＜${mention.slice(1, -1)}＞`
  );
}

function withOverrides(input, options) {
  if (options === undefined) return input;
  if (!isPlainObject(options)) throw new TypeError('options must be a plain object');

  const merged = { ...input };
  for (const field of ['dateLabel', 'tomorrowLabel', 'comment']) {
    if (Object.prototype.hasOwnProperty.call(options, field)) merged[field] = options[field];
  }
  return merged;
}

function formatItems(items, emptyLabel) {
  const displayItems = items.length > 0 ? items : [emptyLabel];
  return displayItems.map((item) => `・${neutralizeSlackMentions(item)}`).join('\n');
}

/** Build a complete incoming-webhook-compatible Slack mrkdwn message. */
function buildSlackMrkdwn(input, options) {
  if (!isPlainObject(input)) throw new TypeError('report must be a plain object');
  const report = normalizeReport(withOverrides(input, options));
  const dateSuffix = report.dateLabel
    ? ` ${neutralizeSlackMentions(report.dateLabel)}`
    : '';
  const tomorrowSuffix = report.tomorrowLabel
    ? `（${neutralizeSlackMentions(report.tomorrowLabel)}）`
    : '';

  const sections = [
    `*日報${dateSuffix}*`,
    `*やったこと*\n${formatItems(report.did, '（記録なし）')}`,
    `*やること${tomorrowSuffix}*\n${formatItems(report.will, '（予定なし）')}`,
  ];

  if (report.comment) {
    sections.push(`*ひとこと*\n${neutralizeSlackMentions(report.comment)}`);
  }

  const message = sections.join('\n\n');
  if (message.length > MAX_SLACK_TEXT_LENGTH) {
    throw new RangeError(`Slack message exceeds ${MAX_SLACK_TEXT_LENGTH} characters`);
  }
  return message;
}

module.exports = {
  MAX_SLACK_TEXT_LENGTH,
  buildSlackMrkdwn,
  neutralizeSlackMentions,
  normalizeReport,
};
