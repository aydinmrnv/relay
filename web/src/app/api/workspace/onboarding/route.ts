import * as z from 'zod';
import { ApiError, json, readJson, withUser } from '@/server/api';
import { completeOnboarding } from '@/server/studio';
import { describeZodError, onboardingSchema } from '@/server/validate';

/** Records that onboarding is done, with the answers, so suggestions can follow them later. */
export async function POST(request: Request) {
  return withUser(request, async (user) => {
    const parsed = onboardingSchema.safeParse(await readJson(request, 20_000));
    if (!parsed.success) throw new ApiError(400, 'INVALID', describeZodError(parsed.error as z.ZodError));
    await completeOnboarding(user.id, parsed.data);
    return json({ ok: true, onboardedAt: new Date().toISOString() });
  });
}
