'use strict';

const holidayJp = require('@holiday-jp/holiday_jp');

const TIME_ZONE = process.env.NIPPOU_TIMEZONE || 'Asia/Tokyo';
process.env.TZ = TIME_ZONE;
const MIN_HOLIDAY_YEAR = 1970;
const MAX_HOLIDAY_YEAR = 2050;
const CLOSED_WEEKDAYS = new Set([0, 3, 6]); // 日曜・水曜・土曜
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const businessDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const japaneseDateLabelFormatter = new Intl.DateTimeFormat('ja-JP', {
  timeZone: TIME_ZONE,
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

function parseDateKey(dateKey) {
  const match = DATE_KEY_PATTERN.exec(dateKey);
  if (!match) {
    throw new TypeError('日付はYYYY-MM-DD形式または有効なDateで指定してください');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new RangeError(`存在しない日付です: ${dateKey}`);
  }

  return { year, month, day };
}

function assertHolidayYearSupported(year) {
  if (year < MIN_HOLIDAY_YEAR || year > MAX_HOLIDAY_YEAR) {
    throw new RangeError(
      `祝日判定に対応できる日付は${MIN_HOLIDAY_YEAR}年から${MAX_HOLIDAY_YEAR}年までです`,
    );
  }
}

function formatDateKey({ year, month, day }) {
  return [year, month, day]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
}

function toBusinessDateKey(value) {
  if (typeof value === 'string') {
    return formatDateKey(parseDateKey(value));
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('日付はYYYY-MM-DD形式または有効なDateで指定してください');
  }

  const parts = Object.fromEntries(
    businessDateFormatter
      .formatToParts(value)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue]),
  );
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  parseDateKey(dateKey);
  return dateKey;
}

function addDaysToDateKey(dateKey, amount) {
  const { year, month, day } = parseDateKey(dateKey);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  const result = formatDateKey({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  });
  parseDateKey(result);
  return result;
}

function dateKeyToDate(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function dateKeyToStartOfDay(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function dateKeyToEndOfDay(dateKey) {
  const { year, month, day } = parseDateKey(dateKey);
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

function isBusinessDay(value) {
  const dateKey = toBusinessDateKey(value);
  const { year, month, day } = parseDateKey(dateKey);
  assertHolidayYearSupported(year);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return !CLOSED_WEEKDAYS.has(weekday) && !holidayJp.isHoliday(dateKey);
}

function nextBusinessDateKey(baseDate) {
  let candidate = addDaysToDateKey(toBusinessDateKey(baseDate), 1);
  while (!isBusinessDay(candidate)) {
    candidate = addDaysToDateKey(candidate, 1);
  }
  return candidate;
}

function nextBusinessDay(baseDate) {
  return dateKeyToDate(nextBusinessDateKey(baseDate));
}

function formatDateLabel(value) {
  const date = typeof value === 'string' ? dateKeyToDate(value) : value;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('有効な日付を指定してください');
  }
  return japaneseDateLabelFormatter.format(date);
}

module.exports = {
  TIME_ZONE,
  MIN_HOLIDAY_YEAR,
  MAX_HOLIDAY_YEAR,
  addDaysToDateKey,
  dateKeyToDate,
  dateKeyToEndOfDay,
  dateKeyToStartOfDay,
  formatDateLabel,
  isBusinessDay,
  nextBusinessDateKey,
  nextBusinessDay,
  toBusinessDateKey,
};
