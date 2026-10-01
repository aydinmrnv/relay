import type { MetadataRoute } from 'next';
import { headers } from 'next/headers';
import { siteOrigin } from '@/server/env';

/** The pages worth finding: the ones robots.txt allows and nothing marks `noindex`. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteOrigin(await headers());
  return ['', '/guide', '/runners', '/privacy', '/terms'].map((path) => ({ url: `${base}${path}`, changeFrequency: 'weekly', priority: path === '' ? 1 : 0.6 }));
}
