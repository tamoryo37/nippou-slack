import { getServerSession } from 'next-auth';
import { kv } from '@vercel/kv';
import { NextResponse } from 'next/server';

export async function GET() {
  const session = await getServerSession();
  if (!session?.user?.email) return NextResponse.json({ connected: false });

  const token = await kv.get(`slack:${session.user.email}`);
  return NextResponse.json({ connected: !!token });
}
