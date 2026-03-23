import { getServerSession } from 'next-auth';
import { kv } from '@vercel/kv';
import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const slackToken = await kv.get<string>(`slack:${session.user.email}`);
  if (!slackToken) return NextResponse.json({ error: 'no_slack_token' }, { status: 400 });

  const { message } = await req.json();

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${slackToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: process.env.SLACK_CHANNEL_ID!,
      text: message,
    }),
  });

  const data = await res.json();
  if (!data.ok) return NextResponse.json({ error: data.error }, { status: 400 });

  return NextResponse.json({ ok: true });
}
