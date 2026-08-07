const { google } = require('googleapis');
const {
  addDaysToDateKey,
  dateKeyToStartOfDay,
  nextBusinessDateKey,
} = require('./holidays');
const {
  isReportTitleExcluded,
  normalizeReportFilters,
  normalizeTitleKey,
} = require('./report-filters');

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/google/callback'
  );
}

function generateAuthUrl(state) {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state,
  });
}

async function exchangeCode(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();

  return { tokens, email: data.email };
}

async function getCalendarEvents(tokens, baseDate, onTokenRefresh, options = {}) {
  const selection = await getCalendarEventSelection(tokens, baseDate, onTokenRefresh, options);
  return selection.included;
}

async function getCalendarEventSelection(tokens, baseDate, onTokenRefresh, options = {}) {
  const oauth2Client = options.oauth2Client || createOAuth2Client();
  oauth2Client.setCredentials(tokens);

  let refreshedTokens = null;
  if (typeof onTokenRefresh === 'function') {
    oauth2Client.on('tokens', (newTokens) => {
      refreshedTokens = { ...tokens, ...newTokens };
    });
  }

  const calendar = options.calendarClient || google.calendar({ version: 'v3', auth: oauth2Client });
  const targetDateKey = nextBusinessDateKey(baseDate);
  const endDateKey = addDaysToDateKey(targetDateKey, 1);
  const start = dateKeyToStartOfDay(targetDateKey);
  const end = dateKeyToStartOfDay(endDateKey);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  // google-auth-library emits `tokens` during the request. Persisting them is
  // part of the request lifecycle so a serverless invocation cannot finish
  // before a refreshed access/refresh token has been stored.
  if (refreshedTokens && typeof onTokenRefresh === 'function') {
    await onTokenRefresh(refreshedTokens);
  }

  return selectCalendarEvents(response.data.items || [], options.reportFilters);
}

function calendarEventExclusionReason(event, reportFilters) {
  const filters = normalizeReportFilters(reportFilters);
  const title = event?.summary || '（タイトルなし）';

  if (
    filters.excludeWorkingLocations
    && (
      event?.eventType === 'workingLocation'
      || event?.event_type === 'workingLocation'
      || event?.workingLocationProperties != null
    )
  ) {
    return '勤務場所';
  }

  if (filters.excludeBusyEvents && normalizeTitleKey(title) === 'busy') {
    return 'ブロック予定';
  }

  if (isReportTitleExcluded(title, filters)) {
    return '除外タイトル';
  }

  return null;
}

function selectCalendarEvents(events, reportFilters) {
  const filters = normalizeReportFilters(reportFilters);
  const selection = { included: [], excluded: [] };

  for (const event of Array.isArray(events) ? events : []) {
    const title = event?.summary || '（タイトルなし）';
    const reason = calendarEventExclusionReason(event, filters);
    if (reason) {
      selection.excluded.push({ title, reason });
    } else {
      selection.included.push(`・${title}`);
    }
  }

  return selection;
}

function formatCalendarEvents(events, reportFilters) {
  return selectCalendarEvents(events, reportFilters).included;
}

module.exports = {
  calendarEventExclusionReason,
  createOAuth2Client,
  exchangeCode,
  formatCalendarEvents,
  generateAuthUrl,
  getCalendarEventSelection,
  getCalendarEvents,
  selectCalendarEvents,
};
