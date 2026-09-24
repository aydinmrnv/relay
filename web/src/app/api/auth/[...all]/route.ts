import { getAuth } from '@/server/auth';

/** Every Better Auth endpoint: sign-up, sign-in, OAuth callbacks, sessions, password reset. */
async function handle(request: Request): Promise<Response> {
  const auth = await getAuth();
  if (auth === null) return Response.json({ code: 'ACCOUNTS_DISABLED', message: 'Accounts are not enabled on this server.' }, { status: 503 });
  return auth.handler(request);
}

export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
