import type { MetadataRoute } from 'next';
import { PUBLIC_URL } from '@/server/env';

/** The site and shared workflows are public; the studio and the API are not worth crawling. */
export default function robots(): MetadataRoute.Robots {
  const base = PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  return {
    rules: { userAgent: '*', allow: ['/', '/s/', '/privacy', '/terms', '/guide'], disallow: ['/api/', '/dashboard', '/templates', '/integrations', '/settings', '/onboarding', '/workflows', '/runs', '/connect', '/runners', '/sign-in', '/sign-up'] },
    ...(base === undefined ? {} : { sitemap: `${base}/sitemap.xml` }),
  };
}
