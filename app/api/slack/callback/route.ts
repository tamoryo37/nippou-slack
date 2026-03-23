import { getServerSession } from 'next-auth';
import { kv } from '@vercel/kv';
import { redirect } from 'next/navigation';

export async function GET(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.email) return redirect('/?error=unauthorized');

  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');
  if (!code) return redirect('/?error=slack_denied');

  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      client_secret: process.env.SLACK_CLIENT_SECRET!,
      code,
      redirect_uri: `${process.env.NEXTAUTH_URL}/api/slack/callback`,
    }),
  });

  const data = await res.json();
  if (!data.ok) return redirect('/?error=slack_token');

  await kv.set(`slack:${session.user.email}`, data.authed_user.access_token);
  redirect('/');
}
