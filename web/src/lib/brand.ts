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
  tagline: 'Automations that run on your own GitHub Actions, in your repository: label an issue, get a reviewed pull request.',
  slug: 'relay',
};

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'workflow';
}
