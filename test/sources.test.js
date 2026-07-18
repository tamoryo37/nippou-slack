'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { formatTogglEntries } = require('../services/toggl');
const { formatCalendarEvents, getCalendarEvents } = require('../services/calendar');

test('Toggl output keeps task names, removes durations, and deduplicates names', () => {
  assert.deepEqual(formatTogglEntries([
    { description: '提案書修正', duration: 3600 },
    { description: '提案書修正', duration: 1800 },
    { description: '顧客MTG', duration: 900 },
    { description: '', duration: 300 },
  ]), [
    '・提案書修正',
    '・顧客MTG',
    '・(タイトルなし)',
  ]);
});

test('Calendar output keeps event names without start times or all-day labels', () => {
  assert.deepEqual(formatCalendarEvents([
    { summary: '顧客定例', start: { dateTime: '2026-07-21T10:00:00+09:00' } },
    { summary: '資料レビュー', start: { date: '2026-07-21' } },
    { summary: '', start: { dateTime: '2026-07-21T14:00:00+09:00' } },
  ]), [
    '・顧客定例',
    '・資料レビュー',
    '・（タイトルなし）',
  ]);
});

test('Calendar token refresh is persisted before getCalendarEvents resolves', async () => {
  const oauth2Client = new EventEmitter();
  oauth2Client.setCredentials = (credentials) => {
    oauth2Client.credentials = credentials;
  };

  let request;
  const calendarClient = {
    events: {
      async list(value) {
        request = value;
        oauth2Client.emit('tokens', { access_token: 'new-access-token' });
        return { data: { items: [{ summary: '翌営業日の定例' }] } };
      },
    },
  };

  let finishPersistence;
  const persistenceGate = new Promise((resolve) => {
    finishPersistence = resolve;
  });
  let persistedTokens;
  let persistenceStarted;
  const started = new Promise((resolve) => {
    persistenceStarted = resolve;
  });

  let resolved = false;
  const resultPromise = getCalendarEvents(
    { refresh_token: 'existing-refresh-token', access_token: 'old-access-token' },
    new Date('2026-07-17T12:00:00+09:00'),
    async (tokens) => {
      persistedTokens = tokens;
      persistenceStarted();
      await persistenceGate;
    },
    { oauth2Client, calendarClient },
  ).then((result) => {
    resolved = true;
    return result;
  });

  await started;
  assert.equal(resolved, false);
  assert.deepEqual(persistedTokens, {
    refresh_token: 'existing-refresh-token',
    access_token: 'new-access-token',
  });
  assert.equal(request.calendarId, 'primary');
  assert.equal(request.singleEvents, true);

  finishPersistence();
  assert.deepEqual(await resultPromise, ['・翌営業日の定例']);
  assert.equal(resolved, true);
});
