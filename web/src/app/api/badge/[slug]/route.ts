import { DEFAULT_BRAND } from '@/lib/brand';
import { databaseConfigured } from '@/server/db';
import { getPublicShare } from '@/server/studio';

/**
 * A README badge for a shared workflow: "<brand> workflow | <name>", linking
 * (in the Markdown the share dialog hands out) to the page anyone can remix
 * it from. Drawn by hand in the shields.io style so it needs no service.
 */
export async function GET(_request: Request, context: RouteContext<'/api/badge/[slug]'>) {
  const { slug } = await context.params;
  const name = slug.replace(/\.svg$/, '');
  let value = 'not found';
  let color = '#9f9fa9';
  try {
    if (databaseConfigured()) {
      const share = await getPublicShare(name);
      if (share !== null) {
        value = share.workflow.name.length > 40 ? `${share.workflow.name.slice(0, 39)}…` : share.workflow.name;
        color = '#6d28d9';
      }
    }
  } catch (error) {
    console.error('[badge]', error);
  }
  return new Response(badge(`${DEFAULT_BRAND.name} workflow`, value, color), {
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=300' },
  });
}

function badge(label: string, value: string, color: string): string {
  const width = (text: string) => Math.round(text.length * 6.4 + 12);
  const left = width(label);
  const right = width(value);
  const total = left + right;
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${left}" height="20" fill="#27272a"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${left / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${left / 2}" y="14">${esc(label)}</text><text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text><text x="${left + right / 2}" y="14">${esc(value)}</text></g></svg>`;
}
