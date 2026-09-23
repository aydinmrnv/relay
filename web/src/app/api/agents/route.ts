import { NextResponse } from 'next/server';
import { agentsStatus, isLocalRequest } from '@/lib/agents/bridge';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!isLocalRequest(request)) return NextResponse.json({ error: 'The local bridge only answers on this machine.' }, { status: 403 });
  return NextResponse.json(await agentsStatus(), { headers: { 'cache-control': 'no-store' } });
}
