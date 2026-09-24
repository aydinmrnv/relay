import type { MetadataRoute } from 'next';
import { PUBLIC_URL } from '@/server/env';

export default function sitemap(): MetadataRoute.Sitemap {
  const base = PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');
  return ['', '/templates', '/guide', '/sign-up', '/privacy', '/terms'].map((path) => ({ url: `${base}${path}`, changeFrequency: 'weekly', priority: path === '' ? 1 : 0.6 }));
}
