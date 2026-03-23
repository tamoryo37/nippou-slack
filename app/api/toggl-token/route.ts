import { getServerSession } from 'next-auth';
import { kv } from '@vercel/kv';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const token = await kv.get(`toggl:${session.user.email}`);
  return NextResponse.json({ token: token ?? null });
}

export async function POST(req: Request) {
  const session = await getServerSession();
  if (!session?.user?.email) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { token } = await req.json();
  await kv.set(`toggl:${session.user.email}`, token);
  return NextResponse.json({ ok: true });
}
