/**
 * The product name is not decided. Everything that says it reads it from here,
 * so renaming is one environment variable (build time) or one field on the
 * settings page (runtime, stored locally). Nothing else in the codebase may
 * hard-code the name.
 */

export interface Brand {
  /** Product name, e.g. "Relay". */
  name: string;
  /** One-line positioning under the logo. */
  tagline: string;
  /** Used for the trigger label, branch prefix and config directory: lowercase, no spaces. */
  slug: string;
  /** Emoji or single glyph used where an icon is needed but no logo exists yet. */
  glyph: string;
}

const envName = process.env['NEXT_PUBLIC_PRODUCT_NAME']?.trim();
const envTagline = process.env['NEXT_PUBLIC_PRODUCT_TAGLINE']?.trim();

export const DEFAULT_BRAND: Brand = {
  name: envName !== undefined && envName.length > 0 ? envName : 'Relay',
  tagline:
    envTagline !== undefined && envTagline.length > 0
      ? envTagline
      : 'Coding agents that plan, review, implement and ship — wired to the tools you already use.',
  slug: slugify(envName !== undefined && envName.length > 0 ? envName : 'relay'),
  glyph: '⟳',
};

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'workflow';
}

/** Derives a full brand from a chosen name, keeping everything else consistent. */
export function brandFromName(name: string, tagline?: string): Brand {
  const trimmed = name.trim();
  const finalName = trimmed.length > 0 ? trimmed : DEFAULT_BRAND.name;
  return {
    name: finalName,
    tagline: tagline?.trim() || DEFAULT_BRAND.tagline,
    slug: slugify(finalName),
    glyph: DEFAULT_BRAND.glyph,
  };
}
