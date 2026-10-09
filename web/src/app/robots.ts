import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { siteOrigin } from '@/server/env';

/**
 * The site, its docs, the playground, recordings and shared workflows are public; the studio and the API
 * are not worth crawling, and the sign-in pages say `noindex` themselves.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/s/', '/play', '/r', '/privacy', '/terms', '/guide', '/runners'],
      disallow: ['/api/', '/play/runs', '/dashboard', '/projects', '/templates', '/integrations', '/settings', '/onboarding', '/workflows', '/runs', '/connect', '/sign-in', '/sign-up'],
    },
    sitemap: `${siteOrigin(await headers())}/sitemap.xml`,
  };
}
