import { NextResponse } from 'next/server';
import { isAgentId, isLocalRequest, isSameOrigin, logout } from '@/lib/agents/bridge';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: RouteContext<'/api/agents/[agent]/logout'>) {
  if (!isLocalRequest(request) || !isSameOrigin(request)) return NextResponse.json({ error: 'The local bridge only answers on this machine.' }, { status: 403 });
  const { agent } = await context.params;
  if (!isAgentId(agent)) return NextResponse.json({ error: 'Unknown agent.' }, { status: 404 });
  const result = await logout(agent);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
