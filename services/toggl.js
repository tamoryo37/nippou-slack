'use strict';

const { dateKeyToEndOfDay, dateKeyToStartOfDay, toBusinessDateKey } = require('./holidays');

async function getTogglEntries(apiToken, baseDate) {
  const dateKey = toBusinessDateKey(baseDate);
  const startOfDay = dateKeyToStartOfDay(dateKey);
  const endOfDay = dateKeyToEndOfDay(dateKey);

  const response = await fetch(
    `https://api.track.toggl.com/api/v9/me/time_entries?start_date=${startOfDay.toISOString()}&end_date=${endOfDay.toISOString()}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiToken}:api_token`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) throw new Error(`Toggl API error: ${response.status}`);

  const entries = await response.json();
  return formatTogglEntries(entries);
}

function formatTogglEntries(entries) {
  // `/me/time_entries` is a latest-entries endpoint and must not be treated as
  // chronological. Sort a copy by the
  // actual start timestamp before dropping time metadata so the report reads
  // in the order the work happened. Entries without a usable timestamp stay
  // after timed entries and keep their original relative order.
  const descriptions = entries
    .map((entry, index) => {
      const startTime = Date.parse(entry && entry.start);
      return {
        entry,
        index,
        startTime: Number.isFinite(startTime) ? startTime : null,
      };
    })
    .sort((left, right) => {
      if (left.startTime === null && right.startTime === null) {
        return left.index - right.index;
      }
      if (left.startTime === null) return 1;
      if (right.startTime === null) return -1;
      return left.startTime - right.startTime || left.index - right.index;
    })
    .map(({ entry }) => (entry && entry.description) || '(タイトルなし)');
  return [...new Set(descriptions)].map((description) => `・${description}`);
}

module.exports = { formatTogglEntries, getTogglEntries };
