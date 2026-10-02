import { BRAND } from '@/lib/brand';
import { databaseConfigured } from '@/server/db';
import { getPublicShare } from '@/server/studio';

/**
 * A README badge for a shared workflow: "Relay workflow | <name>", linking
 * (in the Markdown the share dialog hands out) to the page anyone can remix
 * it from. Drawn by hand in the shields.io style so it needs no service.
 *
 * A link that is gone still answers with a badge, so a README shows "not
 * found" rather than a broken image, but with a 404: nothing should cache or
 * count it as a workflow that exists.
 */
export async function GET(_request: Request, context: RouteContext<'/api/badge/[slug]'>) {
  const { slug } = await context.params;
  const name = slug.replace(/\.svg$/, '');
  let value: string | null = null;
  try {
    if (databaseConfigured()) {
      const share = await getPublicShare(name);
      if (share !== null) value = share.workflow.name.length > 40 ? `${share.workflow.name.slice(0, 39)}…` : share.workflow.name;
    }
  } catch (error) {
    console.error('[badge]', error instanceof Error ? error.message.slice(0, 200) : 'unknown error');
  }
  const found = value !== null;
  return new Response(badge(`${BRAND.name} workflow`, value ?? 'not found', found ? INK : GREY), {
    status: found ? 200 : 404,
    headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': found ? 'public, max-age=300, s-maxage=300' : 'public, max-age=60' },
  });
}

/** The studio's own ink, the colour of its nodes and its mark. */
const INK = '#1a1815';
const GREY = '#9f9fa9';
/** The label's side: a step lighter than the ink, so the two halves read as two. */
const LABEL = '#57534e';

/** Roughly how wide a string is in 11px Verdana: by the shape of each character, not just how many there are. */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if ("ijl.,:;'|!".includes(char)) width += 3.4;
    else if ('ftr ()[]-'.includes(char)) width += 4.6;
    else if ('mwMW@%'.includes(char)) width += 10.2;
    else if (char >= 'A' && char <= 'Z') width += 7.8;
    else if (char > '\u2e7f') width += 11.5;
    else width += 6.6;
  }
  return width;
}

function badge(label: string, value: string, color: string): string {
  const width = (text: string) => Math.round(textWidth(text) + 12);
  const left = width(label);
  const right = width(value);
  const total = left + right;
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${left}" height="20" fill="${LABEL}"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${left / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(label)}</text><text x="${left / 2}" y="14">${esc(label)}</text><text x="${left + right / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(value)}</text><text x="${left + right / 2}" y="14">${esc(value)}</text></g></svg>`;
}
