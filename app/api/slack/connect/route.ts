import { redirect } from 'next/navigation';

export async function GET() {
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID!,
    scope: '',
    user_scope: 'chat:write',
    redirect_uri: `${process.env.NEXTAUTH_URL}/api/slack/callback`,
  });
  redirect(`https://slack.com/oauth/v2/authorize?${params}`);
}
