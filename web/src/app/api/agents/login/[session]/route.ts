import { NextResponse } from 'next/server';
import { cancelLogin, getLogin, isLocalRequest, isSameOrigin } from '@/lib/agents/bridge';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext<'/api/agents/login/[session]'>) {
  if (!isLocalRequest(request)) return NextResponse.json({ error: 'The local bridge only answers on this machine.' }, { status: 403 });
  const { session } = await context.params;
  const found = getLogin(session);
  if (found === undefined) return NextResponse.json({ error: 'No such sign-in.' }, { status: 404 });
  return NextResponse.json(found, { headers: { 'cache-control': 'no-store' } });
}

export async function DELETE(request: Request, context: RouteContext<'/api/agents/login/[session]'>) {
  if (!isLocalRequest(request) || !isSameOrigin(request)) return NextResponse.json({ error: 'The local bridge only answers on this machine.' }, { status: 403 });
  const { session } = await context.params;
  return NextResponse.json({ ok: cancelLogin(session) });
}
