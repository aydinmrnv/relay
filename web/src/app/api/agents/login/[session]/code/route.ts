import { NextResponse } from 'next/server';
import { isLocalRequest, isSameOrigin, submitLoginCode } from '@/lib/agents/bridge';

export const dynamic = 'force-dynamic';

/** Relays a pasted authorization code to the CLI's stdin. The code is not logged and not kept. */
export async function POST(request: Request, context: RouteContext<'/api/agents/login/[session]/code'>) {
  if (!isLocalRequest(request) || !isSameOrigin(request)) return NextResponse.json({ error: 'The local bridge only answers on this machine.' }, { status: 403 });
  const { session } = await context.params;
  let code = '';
  try {
    const body = (await request.json()) as { code?: unknown };
    code = typeof body.code === 'string' ? body.code : '';
  } catch {
    return NextResponse.json({ error: 'Expected JSON with a code.' }, { status: 400 });
  }
  const result = submitLoginCode(session, code);
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
