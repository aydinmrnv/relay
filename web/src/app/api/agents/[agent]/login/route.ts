import { NextResponse } from 'next/server';
import { awaitLoginDetails, isAgentId, isLocalRequest, isLoginMode, isSameOrigin, startLogin } from '@/lib/agents/bridge';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: RouteContext<'/api/agents/[agent]/login'>) {
  if (!isLocalRequest(request) || !isSameOrigin(request)) return NextResponse.json({ error: 'The local bridge only answers on this machine.' }, { status: 403 });
  const { agent } = await context.params;
  if (!isAgentId(agent)) return NextResponse.json({ error: 'Unknown agent.' }, { status: 404 });
  let mode: unknown = 'browser';
  try {
    const body = (await request.json()) as { mode?: unknown };
    if (body.mode !== undefined) mode = body.mode;
  } catch {
    // No body is fine; the browser flow is the default.
  }
  if (!isLoginMode(mode)) return NextResponse.json({ error: 'Unknown sign-in mode.' }, { status: 400 });
  const started = startLogin(agent, mode);
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: 500 });
  const session = (await awaitLoginDetails(started.session.id)) ?? started.session;
  return NextResponse.json(session, { headers: { 'cache-control': 'no-store' } });
}
