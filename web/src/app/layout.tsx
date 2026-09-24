import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { DEFAULT_BRAND } from '@/lib/brand';
import { Providers } from '@/components/providers';
import './globals.css';

// globals.css maps `--font-sans` / `--font-mono` into the Tailwind theme.
const geistSans = Geist({ variable: '--font-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: { default: DEFAULT_BRAND.name, template: `%s · ${DEFAULT_BRAND.name}` },
  description: DEFAULT_BRAND.tagline,
  // The image itself is app/opengraph-image.png, drawn by scripts/gen-brand.mjs.
  openGraph: { title: DEFAULT_BRAND.name, description: DEFAULT_BRAND.tagline, siteName: DEFAULT_BRAND.name, type: 'website' },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
