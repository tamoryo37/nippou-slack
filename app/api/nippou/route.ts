import { getServerSession } from 'next-auth';
import { kv } from '@vercel/kv';
import { NextResponse } from 'next/server';

async function getTogglEntries(apiToken: string) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

  const res = await fetch(
    `https://api.track.toggl.com/api/v9/me/time_entries?start_date=${start.toISOString()}&end_date=${end.toISOString()}`,
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiToken}:api_token`).toString('base64')}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Toggl error: ${res.status}`);

  const entries = await res.json();
  const grouped: Record<string, number> = {};
  for (const e of entries) {
    const desc = e.description || '(タイトルなし)';
    grouped[desc] = (grouped[desc] ?? 0) + (e.duration > 0 ? e.duration : 0);
  }
  return Object.entries(grouped).map(([desc, sec]) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `・${desc}（${h > 0 ? `${h}h${m}m` : `${m}m`}）`;
  });
}

async function getTomorrowEvents(accessToken: string) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate());
  const end = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate() + 1);

  const params = new URLSearchParams({
    calendarId: 'primary',
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
  });

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Calendar error: ${res.status}`);

  const data = await res.json();
  return (data.items ?? []).map((event: any) => {
    const startVal = event.start.dateTime || event.start.date;
    const timeStr = event.start.dateTime
      ? new Date(startVal).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
      : '終日';
    return `・${timeStr} ${event.summary}`;
  });
}

export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const togglToken = await kv.get<string>(`toggl:${session.user.email}`);
  if (!togglToken) return NextResponse.json({ error: 'no_toggl_token' }, { status: 400 });

  const [togglLines, calendarLines] = await Promise.all([
    getTogglEntries(togglToken).catch(() => ['・（取得失敗）']),
    getTomorrowEvents(session.accessToken!).catch(() => ['・（取得失敗）']),
  ]);

  return NextResponse.json({
    toggl: togglLines.length ? togglLines : ['・（記録なし）'],
    calendar: calendarLines.length ? calendarLines : ['・（予定なし）'],
  });
}
