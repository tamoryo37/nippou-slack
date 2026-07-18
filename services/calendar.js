const { google } = require('googleapis');
const { nextBusinessDay } = require('./holidays');

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

async function getCalendarEvents(tokens, baseDate, onTokenRefresh) {
  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials(tokens);

  if (onTokenRefresh) {
    oauth2Client.on('tokens', (newTokens) => {
      onTokenRefresh({ ...tokens, ...newTokens });
    });
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  const tomorrow = nextBusinessDay(baseDate);
  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  const end = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + 1);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return formatCalendarEvents(response.data.items || []);
}

function formatCalendarEvents(events) {
  return events.map((event) => `・${event.summary || '（タイトルなし）'}`);
}

module.exports = {
  createOAuth2Client,
  generateAuthUrl,
  exchangeCode,
  formatCalendarEvents,
  getCalendarEvents,
};
