const holidayJp = require('@holiday-jp/holiday_jp');

function isBusinessDay(date) {
  return date.getDay() !== 0 && date.getDay() !== 6 && !holidayJp.isHoliday(date);
}

function nextBusinessDay(baseDate) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + 1);
  while (!isBusinessDay(d)) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

function formatDateLabel(date) {
  return date.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
}

module.exports = { isBusinessDay, nextBusinessDay, formatDateLabel };
