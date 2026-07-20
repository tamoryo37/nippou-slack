'use strict';

const {
  dateKeyToDate,
  formatDateLabel,
  nextBusinessDateKey,
  toBusinessDateKey,
} = require('./holidays');

class ReportDateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReportDateError';
    this.code = code;
  }
}

function buildDateKey(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseReportDateInput(input, now = new Date()) {
  const todayKey = toBusinessDateKey(now);
  const raw = String(input || '').trim().replace(/\s*の日報\s*$/, '');

  if (!raw) {
    return { date: dateKeyToDate(todayKey), dateKey: todayKey, usedYearShorthand: false };
  }

  let match;
  let year;
  let month;
  let day;
  let usedYearShorthand = false;

  if ((match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw))) {
    [, year, month, day] = match;
  } else if ((match = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(raw))) {
    [, year, month, day] = match;
  } else if ((match = /^(\d{1,2})\/(\d{1,2})$/.exec(raw))) {
    [, month, day] = match;
    [year] = todayKey.split('-');
    usedYearShorthand = true;
  } else if ((match = /^(\d{1,2})月(\d{1,2})日$/.exec(raw))) {
    [, month, day] = match;
    [year] = todayKey.split('-');
    usedYearShorthand = true;
  } else {
    throw new ReportDateError(
      'invalid_format',
      '日付を読み取れませんでした。例: `/nippou 2026-07-17`',
    );
  }

  let dateKey = buildDateKey(Number(year), Number(month), Number(day));

  try {
    dateKeyToDate(dateKey);
  } catch (error) {
    throw new ReportDateError(
      'invalid_date',
      `${error.message}。例: \`/nippou 2026-07-17\``,
    );
  }

  if (dateKey > todayKey) {
    throw new ReportDateError(
      'future_date',
      '未来の日付の日報は作成できません。今日以前の日付を指定してください。',
    );
  }

  return { date: dateKeyToDate(dateKey), dateKey, usedYearShorthand };
}

function resolveReportSchedule(input, now = new Date()) {
  const reportDate = parseReportDateInput(input, now);
  const nextDateKey = nextBusinessDateKey(reportDate.dateKey);
  return {
    ...reportDate,
    dateLabel: formatDateLabel(reportDate.dateKey),
    nextBusinessDateKey: nextDateKey,
    nextBusinessDateLabel: formatDateLabel(nextDateKey),
  };
}

module.exports = { ReportDateError, parseReportDateInput, resolveReportSchedule };
