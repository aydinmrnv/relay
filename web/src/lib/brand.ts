/** What the product is called, in one place, for the screens and the exported files. */

export interface Brand {
  /** Product name. */
  name: string;
  /** One-line positioning under the logo. */
  tagline: string;
  /** The CLI's binary, the trigger label's prefix, the branch prefix and the config directory. */
  slug: string;
}

export const BRAND: Brand = {
  name: 'Relay',
  tagline: 'Coding agents that plan, review, implement and ship — wired to the tools you already use.',
  slug: 'relay',
};

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'workflow';
}
